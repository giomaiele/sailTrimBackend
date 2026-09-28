const OpenAI = require("openai");
const { toFile } = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const aiUsage = require("./aiUsageService.js");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const E2eProject = require("../model/E2eProject");
const E2eTest = require("../model/E2eTest");
const { uploadEvidence } = require("./aws");
const { gherkinToText } = require("./gherkinText");

let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.OPEN_IA || process.env.OPENAI_API_KEY,
    });
  }
  return _openai;
}

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "missing",
    });
  }
  // Metered: every call through the platform key is priced and recorded, so
  // no service can spend Olivia's money invisibly (see aiUsageService).
  return aiUsage.meter(_anthropic, { payer: "platform", action: "e2e", surface: "e2e" });
}

const CLAUDE_MODEL = process.env.E2E_QA_MODEL || "claude-opus-4-7";
const MAX_CASES = parseInt(process.env.E2E_MAX_CASES || "12", 10);
// Whisper-1 hard caps uploads at 25MB. Bigger demos need audio extraction /
// chunking — out of scope for the MVP, so we reject early with a clear message.
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

// ---------- JSON helper (same approach as apiQAService) ----------

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    const m = txt.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

// ---------- Step 1: video → transcript (Whisper) ----------

// Extract a small mono 16kHz mp3 audio track from any video/audio the user
// uploads. This normalizes formats Whisper rejects (e.g. Mac .mov screen
// recordings) AND shrinks the payload by ~50x, so a long demo stays well under
// the 25MB Whisper cap. Runs the bundled ffmpeg binary (ffmpeg-static) — no
// system ffmpeg install needed on the server.
function extractAudio(buffer, filename) {
  return new Promise((resolve, reject) => {
    const ext = (path.extname(filename || "") || ".bin").toLowerCase();
    const inPath = path.join(
      os.tmpdir(),
      `e2e-${crypto.randomUUID()}${ext}`
    );
    fs.writeFileSync(inPath, buffer);

    const ff = spawn(ffmpegPath, [
      "-i", inPath,
      "-vn",            // drop the video track
      "-ac", "1",       // mono
      "-ar", "16000",   // 16kHz — plenty for speech
      "-b:a", "64k",
      "-f", "mp3",
      "pipe:1",         // mp3 to stdout
    ]);

    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("error", (err) => {
      fs.promises.unlink(inPath).catch(() => {});
      reject(err);
    });
    ff.on("close", (code) => {
      fs.promises.unlink(inPath).catch(() => {});
      if (code !== 0) {
        const err = new Error(
          `Could not read audio from the file. ${stderr.slice(-300)}`
        );
        err.statusCode = 422;
        return reject(err);
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function transcribeVideo(buffer, filename) {
  // Extract audio first so format (mov/mkv/…) and size stop mattering.
  const audio = await extractAudio(buffer, filename);
  if (audio.length > WHISPER_MAX_BYTES) {
    const err = new Error(
      `Extracted audio is ${(audio.length / 1024 / 1024).toFixed(1)}MB; max is 25MB. The demo is too long — split it.`
    );
    err.statusCode = 413;
    throw err;
  }
  const file = await toFile(audio, "demo.mp3", { type: "audio/mpeg" });
  const result = await getOpenAI().audio.transcriptions.create({
    file,
    model: "whisper-1",
  });
  return result.text || "";
}

// ---------- Step 2: transcript → BDD test cases (Claude) ----------

const TESTGEN_SYSTEM_PROMPT = `You are a senior QA engineer. You are given the TRANSCRIPT of a screen-recorded product demo where someone walks through a web app while narrating what they do.

Your job: turn the demo into a set of END-TO-END test cases, each written as a BDD (Gherkin) scenario. These are the "what to test" — the actual Playwright code is written later by a separate step, so do NOT write code here.

Return STRICT JSON only, starting with {, matching this exact shape:
{
  "cases": [
    {
      "name": "Short imperative title, e.g. 'User logs in with valid credentials'",
      "kind": "smoke | regression | bughunt",
      "feature": "The user-facing feature this exercises",
      "scenario": "One-line scenario summary",
      "given": ["Preconditions, one per line"],
      "when": ["User actions in order, one per line"],
      "then": ["Expected observable outcomes, one per line"]
    }
  ]
}

Rules:
- Derive cases ONLY from flows actually shown/described in the transcript. Do not invent features that weren't demoed.
- Cover the happy paths shown first (kind "smoke" for the critical login/core flows, "regression" for the rest).
- Add a few "bughunt" cases that probe edges adjacent to what was demoed (empty input, invalid value, cancel mid-flow) — but only for flows that were actually shown.
- Each "when" step must be a single concrete user action ("Click the Save button", "Type 'hello' in the search box"), in order.
- Each "then" must be observable in the UI (text appears, URL changes, item shows in list) — never an internal/DB assertion.
- Generate at most ${MAX_CASES} cases. Prefer fewer, high-value cases over noise.
- Keep every string short. Return ONLY the JSON, no prose.`;

async function generateTestCases(transcript, { anthropicClient = null } = {}) {
  const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "e2e", surface: "e2e" });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    system: TESTGEN_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `DEMO TRANSCRIPT:\n"""\n${transcript}\n"""`,
      },
    ],
  });

  const raw = (response.content || [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  const parsed = safeParseJson(raw);
  const cases = (parsed?.cases || []).slice(0, MAX_CASES);
  if (cases.length === 0) {
    console.warn(
      `e2e generateTestCases: 0 cases (stop=${response.stop_reason}). Raw head: ${raw.slice(0, 200)}`
    );
  }
  return {
    cases,
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}

// ---------- Orchestrator: video → persisted draft tests ----------

async function generateFromVideo({
  projectId,
  featureId = null,
  userId,
  companyId,
  buffer,
  filename,
  mimeType,
  anthropicClient = null,
}) {
  const project = await E2eProject.findOne({ _id: projectId, companyId });
  if (!project) {
    const err = new Error("Project not found");
    err.statusCode = 404;
    throw err;
  }

  // 1) keep the source video in S3 for provenance / re-runs.
  const uploaded = await uploadEvidence(
    buffer,
    filename || "demo.mp4",
    mimeType || "video/mp4"
  );

  // 2) transcribe, then 3) generate BDD cases.
  const transcript = await transcribeVideo(buffer, filename);
  if (!transcript.trim()) {
    const err = new Error("Transcription returned no text from the video.");
    err.statusCode = 422;
    throw err;
  }
  const { cases, usage } = await generateTestCases(transcript, {
    anthropicClient,
  });

  // 4) persist each case as a draft E2eTest tied to the project + user + company.
  const docs = cases.map((c) => ({
    userId,
    companyId,
    projectId: project._id,
    featureId: featureId || null,
    name: c.name || "Untitled test",
    source: "video",
    kind: c.kind || "regression",
    gherkin: {
      feature: c.feature || "",
      scenario: c.scenario || "",
      given: c.given || [],
      when: c.when || [],
      then: c.then || [],
    },
    gherkinText: gherkinToText(c),
    transcript,
    videoUrl: uploaded.url,
    videoKey: uploaded.key,
    status: "draft",
  }));
  const created = docs.length ? await E2eTest.insertMany(docs) : [];

  return {
    transcript,
    tests: created,
    count: created.length,
    usage,
  };
}

module.exports = {
  extractAudio,
  transcribeVideo,
  generateTestCases,
  generateFromVideo,
  CLAUDE_MODEL,
};
