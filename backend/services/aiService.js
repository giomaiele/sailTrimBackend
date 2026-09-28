const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const aiUsage = require("./aiUsageService.js");

let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPEN_IA || process.env.OPENAI_API_KEY });
  }
  return _openai;
}

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
  }
  // Metered: every call through the platform key is priced and recorded, so
  // no service can spend Olivia's money invisibly (see aiUsageService).
  return aiUsage.meter(_anthropic, { payer: "platform", action: "misc", surface: "other" });
}

async function generateTestCases(diff) {
  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are a QA engineer. Given a code diff, generate thorough API test cases in markdown format. For each endpoint changed, provide test cases covering: happy path, edge cases, and invalid inputs. Be concise and actionable.",
      },
      {
        role: "user",
        content: `Generate API test cases for the following code diff:\n\n${diff}`,
      },
    ],
  });

  return completion.choices[0].message.content;
}

const PR_SUMMARY_SYSTEM = `You summarize merged GitHub pull requests for a Slack notification.
Output rules:
- Plain text, no markdown headings.
- Start with a one-sentence high-level summary of what shipped.
- Then bullet points (using "•") of the most relevant concrete changes (new endpoints, behavior changes, schema/db changes, bug fixes, breaking changes).
- End with a short "Risks/things to watch" line if any are evident from the diff, otherwise omit it.
- Skip noise: lockfile churn, formatting-only edits, generated files.
- Keep the whole message under ~1500 characters so it fits comfortably in Slack.`;

async function summarizePR({ diff, title, author, prNumber, baseBranch, prUrl, anthropicClient = null }) {
  const header = [
    title ? `Title: ${title}` : null,
    prNumber ? `PR #${prNumber}` : null,
    author ? `Author: ${author}` : null,
    baseBranch ? `Merged into: ${baseBranch}` : null,
    prUrl ? `URL: ${prUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const userContent = `${header}\n\nDIFF:\n${diff || "(empty diff)"}`;

  const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "misc", surface: "other" });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: PR_SUMMARY_SYSTEM,
    messages: [{ role: "user", content: userContent }],
  });
  const text = (msg.content || [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n")
    .trim();
  return text;
}

module.exports = { generateTestCases, summarizePR };
