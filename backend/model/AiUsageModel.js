const mongoose = require("mongoose");

// One row per Claude call, with what it cost.
//
// Olivia pays for the model on the customer's behalf, so "is this customer
// profitable?" is a question about tokens. Nothing answered it: only the
// backfill job stored its own totals, and everything else — tests, the bug
// hunter, diff analysis, MCP work — spent money invisibly.
//
// Written by the metering wrapper in aiUsageService, never by hand, so a new
// service can't forget to report.
const aiUsageSchema = new mongoose.Schema(
  {
    // What the call was for: docs_generate, suite_generate, judge, pr_diff,
    // bug_hunt, mcp_docs… Free-form on purpose — a new task type should show up
    // in reports on its first run, not after a schema change.
    action: { type: String, default: "unknown", index: true },
    model: { type: String, default: "" },

    tokensIn: { type: Number, default: 0 },
    tokensOut: { type: Number, default: 0 },
    // Cached reads are billed at a fraction; kept apart so the discount is
    // visible instead of hidden inside tokensIn.
    tokensCacheRead: { type: Number, default: 0 },
    tokensCacheWrite: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },

    // Whose key paid. A customer using their own Anthropic key costs Olivia
    // nothing, and that has to be separable in every report.
    payer: { type: String, enum: ["platform", "customer"], default: "platform" },

    // What it was working on, so cost can be read per repo or per MCP project.
    surface: { type: String, enum: ["api", "mcp", "e2e", "other"], default: "other" },
    owner: { type: String, default: "" },
    repo: { type: String, default: "" },
    projectId: { type: mongoose.Schema.Types.ObjectId, default: null },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      index: true,
    },
  },
  { timestamps: true }
);

// The two questions asked of this collection: this company's spend this month,
// and where it went.
aiUsageSchema.index({ companyId: 1, createdAt: -1 });
aiUsageSchema.index({ companyId: 1, action: 1, createdAt: -1 });

module.exports = mongoose.model("AiUsage", aiUsageSchema);
