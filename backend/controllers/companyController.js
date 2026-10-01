const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const Mailjet = require("node-mailjet");

const Company = require("../model/companyModel");
const CompanyInvite = require("../model/companyInviteModel");
const User = require("../model/userModel");
const { encrypt, maskSecret } = require("../services/secretCrypto");
const { logEvent } = require("../services/auditLogger");

const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.oliviatools.co";
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL;
const FROM_NAME = process.env.MAIL_FROM_NAME || "Workspace Invite";

let _mailjet = null;
function getMailjet() {
  if (!_mailjet) {
    _mailjet = Mailjet.apiConnect(
      process.env.MJ_APIKEY_PUBLIC,
      process.env.MJ_APIKEY_PRIVATE
    );
  }
  return _mailjet;
}

/**
 * GET /api/company
 * Returns the current user's company.
 */
const getMyCompany = asyncHandler(async (req, res) => {
  if (!req.user.companyId) {
    return res.status(404).json({ message: "No company" });
  }
  const company = await Company.findById(req.user.companyId);
  res.json({ company });
});

/**
 * GET /api/company/members
 * List all users in my company.
 */
const listMembers = asyncHandler(async (req, res) => {
  if (!req.user.companyId) {
    return res.status(400).json({ message: "No company" });
  }
  const members = await User.find({ companyId: req.user.companyId }).select(
    "_id firstName lastName email role createdAt"
  );
  const pendingInvites = await CompanyInvite.find({
    companyId: req.user.companyId,
    acceptedAt: null,
    expiresAt: { $gt: new Date() },
  }).select("_id email role expiresAt createdAt");
  res.json({ members, pendingInvites });
});

/**
 * POST /api/company/invite
 * body: { email, role? }
 * Only owners can invite.
 */
const inviteMember = asyncHandler(async (req, res) => {
  if (!req.user.companyId) {
    return res.status(400).json({ message: "No company" });
  }
  if (req.user.role !== "owner") {
    return res.status(403).json({ message: "Only owners can invite" });
  }

  const { email, role = "member" } = req.body;
  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "Email inválido" });
  }
  const normalizedEmail = email.toLowerCase();

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser && String(existingUser.companyId) === String(req.user.companyId)) {
    return res.status(400).json({ message: "Ya es miembro" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await CompanyInvite.findOneAndUpdate(
    { companyId: req.user.companyId, email: normalizedEmail, acceptedAt: null },
    {
      $set: {
        companyId: req.user.companyId,
        email: normalizedEmail,
        token,
        role,
        invitedBy: req.user._id,
        expiresAt,
        acceptedAt: null,
      },
    },
    { upsert: true, new: true }
  );

  const company = await Company.findById(req.user.companyId);
  const inviter = await User.findById(req.user._id).select("firstName lastName email");
  const inviteUrl = `${FRONTEND_URL || "http://localhost:3000"}/accept-invite?token=${token}`;

  let emailSent = false;
  let emailError = null;
  if (FROM_EMAIL && process.env.MJ_APIKEY_PUBLIC && process.env.MJ_APIKEY_PRIVATE) {
    try {
      await getMailjet()
        .post("send", { version: "v3.1" })
        .request({
          Messages: [
            {
              From: { Email: FROM_EMAIL, Name: FROM_NAME },
              To: [{ Email: normalizedEmail }],
              Subject: `${inviter.firstName} invited you to ${company.name}`,
              TextPart: `${inviter.firstName} ${inviter.lastName} invited you to join the "${company.name}" workspace. Accept your invitation here: ${inviteUrl}`,
              HTMLPart: `
                <div style="margin: 0; padding: 32px 16px; background: #f4f7fb; font-family: Arial, Helvetica, sans-serif; color: #1f2937;">
                  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">
                    <div style="background: #0d1a36; padding: 24px 28px;">
                      <p style="margin: 0; color: #9fb4d8; font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;">Workspace invitation</p>
                      <h1 style="margin: 8px 0 0; color: #ffffff; font-size: 24px; line-height: 1.25;">You have been invited to ${company.name}</h1>
                    </div>
                    <div style="padding: 28px;">
                      <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6;">
                        <strong>${inviter.firstName} ${inviter.lastName}</strong> (${inviter.email}) invited you to join <strong>${company.name}</strong>.
                      </p>
                      <p style="margin: 0 0 24px; color: #4b5563; font-size: 15px; line-height: 1.6;">
                        Accept the invitation to create your account or sign in and start collaborating with your team.
                      </p>
                      <p style="margin: 0 0 24px;">
                        <a href="${inviteUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 13px 20px; border-radius: 7px; text-decoration: none; font-size: 15px; font-weight: 700;">Accept invitation</a>
                      </p>
                      <p style="margin: 0; color: #6b7280; font-size: 13px; line-height: 1.5;">
                        This invitation link expires in 7 days. If you were not expecting this email, you can safely ignore it.
                      </p>
                    </div>
                  </div>
                </div>
              `,
            },
          ],
        });
      emailSent = true;
    } catch (err) {
      emailError = err.statusCode || err.message || String(err);
      console.error("Mailjet invite error:", emailError);
    }
  } else {
    emailError = "Email not configured (missing FROM_EMAIL or Mailjet keys)";
  }

  res.status(201).json({
    ok: true,
    email: normalizedEmail,
    expiresAt,
    inviteUrl,
    emailSent,
    emailError,
  });
});

/**
 * GET /api/company/invite/:token
 * Public endpoint — used by the front to render the accept page (shows
 * which company invited you, etc.) before the user signs up / logs in.
 */
const getInvite = asyncHandler(async (req, res) => {
  const invite = await CompanyInvite.findOne({
    token: req.params.token,
    acceptedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!invite) return res.status(404).json({ message: "Invitación inválida o expirada" });
  const company = await Company.findById(invite.companyId).select("name");
  res.json({
    email: invite.email,
    role: invite.role,
    company: company ? { _id: company._id, name: company.name } : null,
    expiresAt: invite.expiresAt,
  });
});

/**
 * POST /api/company/accept
 * body: { token }
 * For an EXISTING logged-in user that wants to join via a token.
 * (For brand-new users, the token goes through registerUser.)
 */
const acceptInvite = asyncHandler(async (req, res) => {
  const { token } = req.body;
  const invite = await CompanyInvite.findOne({
    token,
    acceptedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!invite) return res.status(400).json({ message: "Invitación inválida o expirada" });
  if (invite.email.toLowerCase() !== req.user.email.toLowerCase()) {
    return res.status(400).json({ message: "La invitación es para otro email" });
  }

  await User.updateOne(
    { _id: req.user._id },
    { $set: { companyId: invite.companyId, role: invite.role || "member" } }
  );
  await CompanyInvite.updateOne(
    { _id: invite._id },
    { $set: { acceptedAt: new Date() } }
  );
  res.json({ ok: true, companyId: invite.companyId, role: invite.role || "member" });
});

/**
 * DELETE /api/company/members/:userId
 * Only owners can remove. Owner cannot remove themselves.
 */
const removeMember = asyncHandler(async (req, res) => {
  if (req.user.role !== "owner") {
    return res.status(403).json({ message: "Only owners can remove members" });
  }
  if (String(req.params.userId) === String(req.user._id)) {
    return res.status(400).json({ message: "No puedes sacarte a ti mismo" });
  }
  const result = await User.updateOne(
    { _id: req.params.userId, companyId: req.user.companyId },
    { $unset: { companyId: "" }, $set: { role: "owner" } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "Miembro no encontrado" });
  res.json({ ok: true });
});

/**
 * DELETE /api/company/invite/:id
 * Cancel a pending invite.
 */
const cancelInvite = asyncHandler(async (req, res) => {
  if (req.user.role !== "owner") {
    return res.status(403).json({ message: "Only owners can cancel invites" });
  }
  const result = await CompanyInvite.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!result) return res.status(404).json({ message: "Invite no encontrado" });
  res.json({ ok: true });
});

/**
 * GET /api/company/slack
 * Returns Slack channel id and a masked view of the bot token.
 */
const getSlackConfig = asyncHandler(async (req, res) => {
  if (!req.user.companyId) return res.status(400).json({ message: "No company" });
  const company = await Company.findById(req.user.companyId).select(
    "slackChannelId slackBotTokenMask"
  );
  if (!company) return res.status(404).json({ message: "Company not found" });
  res.json({
    slackChannelId: company.slackChannelId || null,
    slackBotTokenMask: company.slackBotTokenMask || null,
    hasSlackBotToken: Boolean(company.slackBotTokenMask),
  });
});

/**
 * PUT /api/company/slack
 * body: { channelId, botToken }
 * Only owners can change.
 */
const saveSlackConfig = asyncHandler(async (req, res) => {
  if (req.user.role !== "owner") {
    return res.status(403).json({ message: "Only owners can change Slack settings" });
  }
  if (!req.user.companyId) return res.status(400).json({ message: "No company" });

  const channelId = (req.body?.channelId || "").trim();
  const botToken = (req.body?.botToken || "").trim();
  if (!channelId) return res.status(400).json({ message: "channelId is required" });
  if (!botToken) return res.status(400).json({ message: "botToken is required" });

  const company = await Company.findById(req.user.companyId);
  if (!company) return res.status(404).json({ message: "Company not found" });

  company.slackChannelId = channelId;
  company.slackBotTokenEncrypted = encrypt(botToken);
  company.slackBotTokenMask = maskSecret(botToken);
  await company.save();

  res.json({
    slackChannelId: company.slackChannelId,
    slackBotTokenMask: company.slackBotTokenMask,
    hasSlackBotToken: true,
  });
});

/**
 * DELETE /api/company/slack
 * Removes the Slack config. Owners only.
 */
const deleteSlackConfig = asyncHandler(async (req, res) => {
  if (req.user.role !== "owner") {
    return res.status(403).json({ message: "Only owners can change Slack settings" });
  }
  if (!req.user.companyId) return res.status(400).json({ message: "No company" });
  const company = await Company.findById(req.user.companyId);
  if (!company) return res.status(404).json({ message: "Company not found" });
  company.slackChannelId = undefined;
  company.slackBotTokenEncrypted = undefined;
  company.slackBotTokenMask = undefined;
  await company.save();
  res.json({ slackChannelId: null, slackBotTokenMask: null, hasSlackBotToken: false });
});

/**
 * GET /api/company/anthropic-key
 * Whether the workspace has its own Anthropic key, and its masked tail.
 */
const getCompanyAnthropicKey = asyncHandler(async (req, res) => {
  if (!req.user.companyId) return res.status(400).json({ message: "No company" });
  const company = await Company.findById(req.user.companyId).select(
    "anthropicKeyMask"
  );
  if (!company) return res.status(404).json({ message: "Company not found" });
  res.json({
    anthropicKeyMask: company.anthropicKeyMask || null,
    hasAnthropicKey: !!company.anthropicKeyMask,
  });
});

/**
 * PUT /api/company/anthropic-key
 * Set the WORKSPACE's Anthropic key: every member's work and every watcher run
 * bills that account instead of Olivia's. Owners only — it's a billing
 * decision, and a member shouldn't be able to redirect the company's spend.
 */
const saveCompanyAnthropicKey = asyncHandler(async (req, res) => {
  if (req.user.role !== "owner") {
    return res
      .status(403)
      .json({ message: "Only owners can set the workspace's Anthropic key" });
  }
  if (!req.user.companyId) return res.status(400).json({ message: "No company" });
  const apiKey = String(req.body?.apiKey || "").trim();
  if (!apiKey) return res.status(400).json({ message: "apiKey is required" });

  const company = await Company.findById(req.user.companyId);
  if (!company) return res.status(404).json({ message: "Company not found" });

  company.anthropicKeyEncrypted = encrypt(apiKey);
  company.anthropicKeyMask = maskSecret(apiKey);
  company.anthropicKeySetBy = req.user._id;
  await company.save();

  await logEvent({
    event: "company_anthropic_key_saved",
    req,
    user: req.user,
    targetType: "Company",
    targetId: String(company._id),
  });

  res.json({
    anthropicKeyMask: company.anthropicKeyMask,
    hasAnthropicKey: true,
  });
});

/**
 * DELETE /api/company/anthropic-key
 * Back to Olivia's key — and back to the plan's budget.
 */
const deleteCompanyAnthropicKey = asyncHandler(async (req, res) => {
  if (req.user.role !== "owner") {
    return res
      .status(403)
      .json({ message: "Only owners can change the workspace's Anthropic key" });
  }
  if (!req.user.companyId) return res.status(400).json({ message: "No company" });
  const company = await Company.findById(req.user.companyId);
  if (!company) return res.status(404).json({ message: "Company not found" });

  company.anthropicKeyEncrypted = undefined;
  company.anthropicKeyMask = undefined;
  company.anthropicKeySetBy = undefined;
  await company.save();

  await logEvent({
    event: "company_anthropic_key_removed",
    req,
    user: req.user,
    targetType: "Company",
    targetId: String(company._id),
  });

  res.json({ anthropicKeyMask: null, hasAnthropicKey: false });
});

module.exports = {
  getMyCompany,
  listMembers,
  inviteMember,
  getInvite,
  acceptInvite,
  removeMember,
  cancelInvite,
  getSlackConfig,
  saveSlackConfig,
  deleteSlackConfig,
  getCompanyAnthropicKey,
  saveCompanyAnthropicKey,
  deleteCompanyAnthropicKey,
};
