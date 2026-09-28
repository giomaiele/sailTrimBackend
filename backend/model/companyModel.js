const mongoose = require("mongoose");

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    plan: {
      type: String,
      enum: ["free", "pro", "enterprise", "test"],
      default: "free",
    },
    // Overrides the plan's monthly Claude budget for this one company. Set from
    // the admin page when a customer is worth more (or less) than their tier —
    // there is no billing system yet, so the deal lives here.
    aiBudgetUsd: { type: Number, default: null },
    // Free-text note for whoever changed the plan by hand: "paid Sept invoice",
    // "trial extended to Oct 15". Without it, nobody remembers why.
    planNote: { type: String, default: "" },
    slackChannelId: { type: String },
    slackBotTokenEncrypted: { type: String },
    slackBotTokenMask: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Company", companySchema);
