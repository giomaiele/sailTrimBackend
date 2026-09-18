const mongoose = require("mongoose");

const backfillJobSchema = new mongoose.Schema({
  installationId: { type: Number, required: true },
  owner: { type: String, required: true },
  repo: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  status: {
    type: String,
    enum: ["pending", "running", "completed", "failed"],
    default: "pending",
  },
  filesFound: { type: Number, default: 0 },
  filesProcessed: { type: Number, default: 0 },
  filesSkipped: { type: Number, default: 0 },
  filesCached: { type: Number, default: 0 },
  // Re-document every file, even ones unchanged since the last run (skips the
  // SHA cache). Docs are updated in place, so tests and variables keep pointing
  // at the same endpoints.
  force: { type: Boolean, default: false },
  // Files where Claude call or the Mongo save threw (e.g. a truncated
  // response) — distinct from "Claude looked at this file and correctly
  // found zero endpoints". Surfaced so a partial failure is visible from
  // the job status API, not just server logs.
  filesFailed: { type: Number, default: 0 },
  failedFiles: [{ path: String, error: String }],
  endpointsDetected: { type: Number, default: 0 },
  zombieDocsRemoved: { type: Number, default: 0 },
  tokensInput: { type: Number, default: 0 },
  tokensOutput: { type: Number, default: 0 },
  model: { type: String },
  error: { type: String },
  startedAt: { type: Date },
  finishedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("BackfillJob", backfillJobSchema);
