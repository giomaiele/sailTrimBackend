const mongoose = require("mongoose");

// A read-only link to one QA report, openable WITHOUT an Olivia account.
//
// The customer's customer is the audience: they get a URL, they see coverage,
// tests and bugs, and nothing else. The token is the only credential, so it is
// long and random, the link can be revoked, and it can be given an expiry —
// a report shared once shouldn't stay readable forever by default.
const shareLinkSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    // Only QA reports today. Named so a future "shared docs" link doesn't have
    // to reuse (and silently widen) this one.
    kind: { type: String, enum: ["qa-report"], default: "qa-report" },

    // What the link resolves to. Exactly one shape is filled:
    // an API repo (owner+repo), an imported API project, or an MCP project.
    scope: {
      surface: { type: String, enum: ["api", "mcp"], required: true },
      owner: { type: String, default: "" },
      repo: { type: String, default: "" },
      projectId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },

    // Frozen period, so the link keeps meaning what it meant when it was sent.
    // Coverage is still read live — a report that never updates is a screenshot.
    period: {
      from: { type: Date, default: null },
      to: { type: Date, default: null },
    },

    label: { type: String, default: "" },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    views: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

shareLinkSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("ShareLink", shareLinkSchema);
