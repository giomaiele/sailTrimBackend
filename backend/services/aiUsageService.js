const { AsyncLocalStorage } = require("async_hooks");
const AiUsage = require("../model/AiUsageModel");

// Who the current work belongs to, carried alongside the call stack.
//
// The first version recorded every call with companyId: null — the services
// that call Claude are three or four layers below the request, and passing the
// company down each of them is exactly the kind of plumbing someone forgets.
// AsyncLocalStorage keeps it on the side: set once (per request, per watcher
// run), read by the recorder, invisible to everything in between.
const store = new AsyncLocalStorage();

/** Run `fn` with this owner attached to every Claude call inside it. */
function runWith(ctx, fn) {
  return store.run({ ...(store.getStore() || {}), ...ctx }, fn);
}

/** Attach the owner to the CURRENT scope (for middleware that runs after it). */
function setContext(ctx) {
  const current = store.getStore();
  if (current) Object.assign(current, ctx);
}

function currentContext() {
  return store.getStore() || {};
}

// Every Claude call, counted and priced — without asking each service to
// remember to report.
//
// The trick is where the counting happens: services keep calling
// `client.messages.create(...)` exactly as before, but the client they get is
// wrapped, so the row is written on the way back. A service added next month is
// metered the day it ships, and a forgotten `recordUsage()` can't leave a
// customer's spend invisible.
//
// Prices are per MILLION tokens, first-party Anthropic API rates.
const PRICES = {
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
// An unknown model id (a new release, a typo) must not be counted as free —
// price it like the expensive tier so the number errs against us, never for us.
const FALLBACK_PRICE = { in: 5, out: 25 };

// Cache reads are ~10% of the input rate and writes ~125%. Close enough to make
// caching visible in reports; exact per-model rates can replace this later.
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

function priceFor(model) {
  return PRICES[model] || FALLBACK_PRICE;
}

function costOf({ model, tokensIn, tokensOut, tokensCacheRead = 0, tokensCacheWrite = 0 }) {
  const p = priceFor(model);
  const millions = (n) => (n || 0) / 1_000_000;
  return (
    millions(tokensIn) * p.in +
    millions(tokensOut) * p.out +
    millions(tokensCacheRead) * p.in * CACHE_READ_FACTOR +
    millions(tokensCacheWrite) * p.in * CACHE_WRITE_FACTOR
  );
}

async function record(callCtx, usage, model) {
  try {
    // The call's own context wins; the ambient one fills in who it was for.
    const ctx = { ...currentContext(), ...callCtx };
    const row = {
      action: ctx.action || "unknown",
      model: model || ctx.model || "",
      tokensIn: usage?.input_tokens || 0,
      tokensOut: usage?.output_tokens || 0,
      tokensCacheRead: usage?.cache_read_input_tokens || 0,
      tokensCacheWrite: usage?.cache_creation_input_tokens || 0,
      payer: ctx.payer || "platform",
      surface: ctx.surface || "other",
      owner: ctx.owner || "",
      repo: ctx.repo || "",
      projectId: ctx.projectId || null,
      userId: ctx.userId || null,
      companyId: ctx.companyId || null,
    };
    row.costUsd = costOf(row);
    await AiUsage.create(row);
  } catch (err) {
    // Accounting must never break the feature it is measuring.
    console.error("[ai-usage] could not record:", err.message);
  }
}

/**
 * Wrap an Anthropic client so every `messages.create` writes a usage row.
 *
 * Returns a proxy, so the wrapped client is a drop-in: same methods, same
 * shapes, plus `.withUsage({...})` to add or override context (the action name,
 * the repo being worked on) for a specific piece of work.
 */
function meter(client, baseCtx = {}) {
  if (!client || client.__metered) return client;

  const wrap = (ctx) =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "__metered") return true;
        if (prop === "withUsage") return (extra) => wrap({ ...ctx, ...extra });

        if (prop === "messages") {
          const messages = Reflect.get(target, prop, receiver);
          return new Proxy(messages, {
            get(mTarget, mProp, mReceiver) {
              const value = Reflect.get(mTarget, mProp, mReceiver);
              if (mProp !== "create" || typeof value !== "function") return value;
              return async (...args) => {
                const resp = await value.apply(mTarget, args);
                // Fire and forget: the caller is waiting on the model's answer,
                // not on our bookkeeping.
                record(ctx, resp?.usage, resp?.model || args[0]?.model).catch(
                  () => {}
                );
                return resp;
              };
            },
          });
        }

        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return wrap(baseCtx);
}

/** Spend for one company over a window (defaults to the current month). */
async function spendSince(companyId, from = startOfMonth()) {
  const rows = await AiUsage.aggregate([
    { $match: { companyId, createdAt: { $gte: from } } },
    {
      $group: {
        _id: "$action",
        costUsd: { $sum: "$costUsd" },
        calls: { $sum: 1 },
        tokensIn: { $sum: "$tokensIn" },
        tokensOut: { $sum: "$tokensOut" },
      },
    },
    { $sort: { costUsd: -1 } },
  ]);

  return {
    from,
    totalUsd: rows.reduce((n, r) => n + r.costUsd, 0),
    calls: rows.reduce((n, r) => n + r.calls, 0),
    byAction: rows.map((r) => ({
      action: r._id,
      costUsd: r.costUsd,
      calls: r.calls,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
    })),
  };
}

function startOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Add context to an already-metered client (the customer-key one, created far
 * from the service that ends up using it). A plain client passes through
 * untouched, so call sites don't have to care which kind they hold.
 */
function tag(client, ctx) {
  return client && typeof client.withUsage === "function"
    ? client.withUsage(ctx)
    : client;
}

module.exports = {
  meter,
  tag,
  record,
  runWith,
  setContext,
  currentContext,
  costOf,
  spendSince,
  startOfMonth,
  PRICES,
};
