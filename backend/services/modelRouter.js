// Which Claude model does each job get.
//
// Running everything on Opus is how a $500/month customer turns into a
// $900/month bill. The split is by what the task actually needs:
//
//   - Reading source code and writing docs is the product. Opus.
//   - Writing test cases from a doc is structured work off a short spec.
//     Sonnet does it at 40% of the price.
//   - Deciding whether a response satisfies "each item has an id" is the
//     highest-volume call in the system and the simplest. Haiku, at a fifth.
//
// Every task can be overridden with an env var, so the tradeoff can be retuned
// (per deployment, per customer complaint) without a release.
const TASKS = {
  // Source code -> endpoint and tool documentation.
  docs: process.env.CLAUDE_MODEL_DOCS,
  // Doc -> saved smoke/regression suites, and refining a case.
  suites: process.env.CLAUDE_MODEL_SUITES,
  // Response vs. plain-English assertions. Thousands of small calls.
  judge: process.env.CLAUDE_MODEL_JUDGE,
  // PR diff -> which endpoints/tools it touched.
  diff: process.env.CLAUDE_MODEL_DIFF,
  // The bug hunter: invents cases against a live API and reads the results.
  bughunt: process.env.CLAUDE_MODEL_BUGHUNT,
};

const DEFAULTS = {
  docs: "claude-opus-4-7",
  suites: "claude-sonnet-5",
  judge: "claude-haiku-4-5",
  diff: "claude-sonnet-5",
  bughunt: "claude-opus-4-7",
};

// CLAUDE_QA_MODEL used to pick the model for all of these. It stays as a
// fallback only where the expensive model is still the right answer — letting
// it win everywhere would undo the whole point of the split.
const LEGACY = process.env.CLAUDE_QA_MODEL;
const LEGACY_APPLIES = new Set(["docs", "bughunt"]);

function modelFor(task) {
  if (TASKS[task]) return TASKS[task];
  if (LEGACY && LEGACY_APPLIES.has(task)) return LEGACY;
  return DEFAULTS[task] || DEFAULTS.docs;
}

module.exports = { modelFor, DEFAULTS };
