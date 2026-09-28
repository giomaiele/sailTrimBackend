const Anthropic = require("@anthropic-ai/sdk");
const aiUsage = require("./aiUsageService.js");
const { modelFor } = require("./modelRouter.js");
const { getOctokit } = require("./githubService");

// Which existing endpoints or tools did a merged PR actually TOUCH?
//
// The watchers already compare contracts (params, status codes, schemas), but a
// contract only moves for some changes. A new response field, a validation rule
// or a logic fix leaves it identical, and those endpoints went unlabeled. The
// diff is the one thing that knows what was touched, so read it and ask the
// model to map it onto the endpoints/tools that exist. Language-agnostic — no
// per-framework parsing.
//
// API: when the diff is read in full it decides which endpoints are labeled —
// the docs are rewritten by a model on every merge, so contract differences
// alone include wording noise. The contract comparison is the fallback when the
// diff can't be read (or is truncated). MCP: the live server's schemas are real,
// so there the diff adds to the schema comparison instead.

// Reading a diff and matching it to a list of names doesn't need the top
// model — see modelRouter.
// A big PR (a release merging develop into main) is read in several batches
// instead of being cut at one size — a cut hides changes. Batches are whole
// files, never a file split in two.
const MAX_BATCH_CHARS = 50000;
// One file's patch larger than a batch is cut; the read is then marked
// truncated so callers fall back instead of trusting it.
const MAX_PATCH_CHARS = 45000;
// Cost ceiling: past this many batches the rest isn't read (and the read is
// marked truncated).
const MAX_BATCHES = 8;
// Source files GitHub gives no patch for (too large to diff) hide a change we
// can't see. Lockfiles and assets without a patch don't matter.
const SOURCE_EXT = /\.(m?[jt]sx?|cjs|py|go|rb|java|kt|php|cs|rs|scala|swift|ex|exs)$/i;

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
  }
  // Metered: every call through the platform key is priced and recorded, so
  // no service can spend Olivia's money invisibly (see aiUsageService).
  return aiUsage.meter(_anthropic, { payer: "platform" });
}

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
  }
}

// Every file of the PR. The endpoint returns 100 per page (3000 max), and the
// shared helper only read the first page — a release PR lost everything after
// file 100 without anyone noticing.
async function fetchPRFiles({ installationId, owner, repo, prNumber }) {
  if (!installationId || !prNumber) return [];
  const octokit = await getOctokit(installationId);
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: prNumber, per_page: 100, page }
    );
    files.push(...data);
    if (data.length < 100) break;
  }
  return files;
}

// Split the PR into prompt-sized batches of whole files. Files in the same
// directory are kept next to each other, so a helper and the route that uses it
// usually land in the same batch — a change spread over two batches is the one
// thing a batch-by-batch read can miss.
//
// Returns { batches: string[], truncated }. `truncated` is true when anything
// wasn't read: a patch cut to size, a source file GitHub gave no diff for, or
// batches past the cost ceiling.
function buildDiffBatches(files) {
  const sorted = [...(files || [])].sort((a, b) =>
    String(a.filename).localeCompare(String(b.filename))
  );
  const batches = [];
  let current = "";
  let truncated = false;

  for (const f of sorted) {
    const header = `### ${f.filename} (${f.status})\n`;
    let chunk;
    if (!f.patch) {
      if (SOURCE_EXT.test(f.filename || "") && f.status !== "removed") truncated = true;
      chunk = `${header}(no textual diff)\n\n`;
    } else {
      let patch = f.patch;
      if (patch.length > MAX_PATCH_CHARS) {
        patch = `${patch.slice(0, MAX_PATCH_CHARS)}\n… [patch truncated]`;
        truncated = true;
      }
      chunk = `${header}\`\`\`diff\n${patch}\n\`\`\`\n\n`;
    }
    if (current && current.length + chunk.length > MAX_BATCH_CHARS) {
      batches.push(current);
      current = "";
    }
    current += chunk;
  }
  if (current) batches.push(current);

  if (batches.length > MAX_BATCHES) {
    truncated = true;
    batches.length = MAX_BATCHES;
  }
  return { batches, truncated };
}

// The whole diff as one string — kept for callers that want a single text.
function buildDiffText(files) {
  return buildDiffBatches(files).batches.join("");
}

const API_SYSTEM = `You receive the diff of a merged pull request and the list of HTTP endpoints that exist in the repository after the merge.

Decide which of THOSE endpoints this diff changed in any way: request params or body, response fields or shape, status codes, validation, business logic, or a helper whose behavior only affects that endpoint.

Return STRICT JSON only:
{"touched":[{"key":"<copied exactly from the list>","summary":"one short sentence describing what changed"}]}

Rules:
- Only use keys from the list, copied exactly.
- A change to shared code counts for an endpoint only if it clearly changes that endpoint's behavior.
- Do not include an endpoint just because the diff mentions it in a comment or test.
- Return {"touched":[]} if the diff doesn't change any listed endpoint.`;

const MCP_SYSTEM = `You receive the diff of a merged pull request and the list of MCP tools that existed on the server BEFORE the merge.

1) Decide which of THOSE tools this diff changed in any way: its parameters, validation, logic, or what it returns.
2) For each, say whether the change alters the tool's INTERFACE — its input parameters (names, types, required) or the shape of what it returns.
3) List any tool this diff newly DEFINES that is not in the list.
4) List any tool from the list this diff DELETES (its definition is removed).

Return STRICT JSON only:
{"touched":[{"key":"<tool name copied exactly from the list>","summary":"one short sentence","changesInterface":true}],"addedTools":["new_tool_name"],"removedTools":["deleted_tool_name"]}

Rules:
- "touched" keys must come from the list, copied exactly.
- A change to shared code counts for a tool only if it clearly changes that tool's behavior.
- Only count changes to the tool's OWN code on the MCP server (its definition, or a helper inside the MCP server that it calls). A change to an HTTP API endpoint, route or backend file that the tool calls does NOT count — even if the tool wraps that endpoint.
- Do not include a tool just because the diff mentions it in a comment or test.
- A deleted tool goes in "removedTools" ONLY, never in "touched".
- Return {"touched":[],"addedTools":[],"removedTools":[]} if the diff doesn't affect any tool.`;

/**
 * @param kind  "api" (items are "METHOD /path") or "mcp" (items are tool names)
 * @returns {{ touched: {key, summary, changesInterface?}[], addedTools: string[],
 *             removedTools: string[], analyzed: boolean, truncated: boolean }}
 *          Big diffs are read in batches (one model call each) and merged.
 *          `analyzed` is false when there was nothing to analyze or the call
 *          failed — callers treat that as "unknown", never as "nothing changed".
 */
async function findTouched({ files, items, kind, anthropicClient = null }) {
  const empty = {
    touched: [],
    addedTools: [],
    removedTools: [],
    analyzed: false,
    truncated: false,
  };
  if (!(items || []).length) return empty;
  const { batches, truncated } = buildDiffBatches(files);
  if (!batches.length) return empty;

  const client = anthropicClient || getAnthropic();
  const allowed = new Set(items);
  const touchedByKey = new Map();
  const added = new Set();
  const removed = new Set();

  for (let i = 0; i < batches.length; i++) {
    const part =
      batches.length > 1
        ? `\n\n(This is part ${i + 1} of ${batches.length} of the diff. Judge only what this part shows.)`
        : "";
    const resp = await client.messages.create({
      model: modelFor("diff"),
      max_tokens: 2000,
      system: kind === "mcp" ? MCP_SYSTEM : API_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `${kind === "mcp" ? "TOOLS" : "ENDPOINTS"}:\n${items.join("\n")}\n\n` +
            `PULL REQUEST DIFF:${part}\n${batches[i]}`,
        },
      ],
    });
    const text = (resp?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = safeParseJson(text);
    // One unreadable batch makes the whole read incomplete — report it as not
    // analyzed so callers fall back, rather than trusting a partial answer.
    if (!parsed) return { ...empty, truncated };

    // Never trust a key the model made up — only what we actually listed.
    for (const t of Array.isArray(parsed.touched) ? parsed.touched : []) {
      if (!t || !allowed.has(t.key)) continue;
      const summary = String(t.summary || "").trim();
      const prev = touchedByKey.get(t.key);
      if (prev) {
        if (summary && !prev.summary.includes(summary)) {
          prev.summary = prev.summary ? `${prev.summary} ${summary}` : summary;
        }
        prev.changesInterface = prev.changesInterface || t.changesInterface === true;
      } else {
        touchedByKey.set(t.key, {
          key: t.key,
          summary,
          changesInterface: t.changesInterface === true,
        });
      }
    }
    for (const n of Array.isArray(parsed.addedTools) ? parsed.addedTools : []) {
      const name = String(n || "").trim();
      if (name && !allowed.has(name)) added.add(name);
    }
    // A deleted tool can only be one that existed before, so it must be a
    // listed key — same rule as `touched`.
    for (const n of Array.isArray(parsed.removedTools) ? parsed.removedTools : []) {
      const name = String(n || "").trim();
      if (name && allowed.has(name)) removed.add(name);
    }
  }

  // Moved in one batch, deleted in another (a tool renamed across files): the
  // deletion wins only if no batch also defines it.
  for (const name of removed) if (added.has(name)) removed.delete(name);

  return {
    touched: [...touchedByKey.values()].filter((t) => !removed.has(t.key)),
    addedTools: [...added],
    removedTools: [...removed],
    analyzed: true,
    truncated,
  };
}

module.exports = { fetchPRFiles, buildDiffBatches, buildDiffText, findTouched };
