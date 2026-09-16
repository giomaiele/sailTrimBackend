const ApiQaConfig = require("../model/ApiQaConfig");
const ApiProject = require("../model/ApiProject");
const Bug = require("../model/BugModel");
const Doc = require("../model/DocModel");
const TestRun = require("../model/TestRunModel");
const { encrypt, maskSecret, decrypt } = require("../services/secretCrypto");
const apiQAService = require("../services/apiQAService");
const apiSuiteService = require("../services/apiSuiteService");
const SuiteRun = require("../model/SuiteRunModel");
const openApiService = require("../services/openApiService");
const { getUserAnthropicClient } = require("../services/userKeyService");
const {
  getOctokit,
  getDefaultBranch,
  findSpecCandidates,
  fetchFileAtRef,
} = require("../services/githubService");

function requireCompany(req, res) {
  if (!req.user.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

function serializeConfig(cfg) {
  if (!cfg) return null;
  const auth = cfg.auth || { type: "none" };
  return {
    _id: cfg._id,
    owner: cfg.owner,
    repo: cfg.repo,
    baseUrl: cfg.baseUrl,
    auth: {
      type: auth.type,
      headerName: auth.headerName || "",
      username: auth.username || "",
      valueMasked: maskSecret(decrypt(auth.valueEncrypted)),
      passwordMasked: maskSecret(decrypt(auth.passwordEncrypted)),
    },
    defaultHeaders: cfg.defaultHeaders
      ? Object.fromEntries(cfg.defaultHeaders)
      : {},
    variables: (cfg.variables || []).map((v) => ({
      key: v.key,
      // Secrets go out masked — the value on the wire is ciphertext and the UI
      // has no use for it. Saving a masked value back means "unchanged".
      value: v.secret ? maskSecret(decrypt(v.value)) : v.value,
      secret: Boolean(v.secret),
    })),
    updatedAt: cfg.updatedAt,
  };
}

async function getConfig(req, res) {
  if (!requireCompany(req, res)) return;
  const { owner, repo } = req.params;
  const cfg = await ApiQaConfig.findOne({
    companyId: req.user.companyId,
    owner,
    repo,
  });
  if (!cfg) return res.status(404).json({ message: "No config" });
  res.json(serializeConfig(cfg));
}

async function upsertConfig(req, res) {
  if (!requireCompany(req, res)) return;
  const { owner, repo } = req.params;
  const { baseUrl, auth = {}, defaultHeaders = {}, variables = [] } = req.body;

  if (!baseUrl) {
    return res.status(400).json({ message: "baseUrl is required" });
  }

  const existing = await ApiQaConfig.findOne({
    companyId: req.user.companyId,
    owner,
    repo,
  });

  // Variables marked secret are encrypted at rest, same as an ApiProject's.
  // A blank or masked incoming value means "unchanged" (the UI never echoes a
  // secret back), so editing another field can't silently wipe a token.
  const prevVars = new Map((existing?.variables || []).map((v) => [v.key, v]));
  const cleanVariables = (Array.isArray(variables) ? variables : [])
    .filter((v) => v && typeof v.key === "string" && v.key.trim())
    .map((v) => {
      const key = v.key.trim();
      if (!v.secret) {
        return { key, value: String(v.value ?? "").trim(), secret: false };
      }
      const incoming = String(v.value ?? "");
      const looksMasked = !incoming.trim() || /\*/.test(incoming);
      return {
        key,
        value: looksMasked ? prevVars.get(key)?.value || "" : encrypt(incoming),
        secret: true,
      };
    });

  // The dialog only ever shows a MASKED token, so an empty value on save means
  // "unchanged", NOT "clear it". Preserve the existing secret when no new value
  // is sent (same auth type) — otherwise re-saving the config wipes the token.
  const prevAuth = existing?.auth || {};
  const nextType = auth.type || "none";
  const keepPrev = nextType !== "none" && prevAuth.type === nextType;

  const update = {
    userId: req.user._id,
    companyId: req.user.companyId,
    owner,
    repo,
    baseUrl,
    defaultHeaders,
    variables: cleanVariables,
    updatedAt: new Date(),
    auth: {
      type: nextType,
      headerName: auth.headerName || "",
      username: auth.username || "",
      valueEncrypted: auth.value
        ? encrypt(auth.value)
        : keepPrev
          ? prevAuth.valueEncrypted || ""
          : "",
      passwordEncrypted: auth.password
        ? encrypt(auth.password)
        : keepPrev
          ? prevAuth.passwordEncrypted || ""
          : "",
    },
  };

  const cfg = await ApiQaConfig.findOneAndUpdate(
    { companyId: req.user.companyId, owner, repo },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.json(serializeConfig(cfg));
}

async function findBugs(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await apiQAService.findBugs({
      docId,
      userId: req.user._id,
      companyId: req.user.companyId,
      anthropicClient,
      authSchemeName: req.body?.authSchemeName || "",
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("findBugs error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function getBugs(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  const bugs = await Bug.find({
    companyId: req.user.companyId,
    docId,
  }).sort({ createdAt: -1 });
  res.json(bugs);
}

async function deleteBug(req, res) {
  if (!requireCompany(req, res)) return;
  await Bug.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  res.json({ message: "Bug deleted" });
}

// Mark a bug open / fixed (done) / ignored.
async function updateBugStatus(req, res) {
  if (!requireCompany(req, res)) return;
  const { status } = req.body;
  if (!["open", "fixed", "ignored"].includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }
  const bug = await Bug.findOneAndUpdate(
    { _id: req.params.id, companyId: req.user.companyId },
    { status },
    { new: true }
  );
  if (!bug) return res.status(404).json({ message: "Bug not found" });
  res.json(bug);
}

async function getCollection(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  const doc = await Doc.findOne({
    _id: docId,
    companyId: req.user.companyId,
  });
  if (!doc) return res.status(404).json({ message: "Doc not found" });
  const config = await ApiQaConfig.findOne({
    companyId: req.user.companyId,
    owner: doc.owner,
    repo: doc.repo,
  });
  if (!config)
    return res.status(400).json({ message: "No QA config for this repo" });

  const anthropicClient = await getUserAnthropicClient(req.user._id);
  const { cases } = await apiQAService.generateTestCases(doc, { anthropicClient });
  const collection = apiQAService.buildPostmanCollection({
    doc,
    config,
    testCases: cases,
  });
  res.json(collection);
}

async function listRuns(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  const runs = await TestRun.find(
    { companyId: req.user.companyId, docId },
    { executions: 0, postmanCollection: 0 }
  ).sort({ createdAt: -1 });
  res.json(runs);
}

async function getRun(req, res) {
  if (!requireCompany(req, res)) return;
  const run = await TestRun.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!run) return res.status(404).json({ message: "Run not found" });
  res.json(run);
}

// ======================= Spec-import (API Project) flow =======================

function serializeProject(p) {
  if (!p) return null;
  const auth = p.auth || { type: "none" };
  return {
    _id: p._id,
    name: p.name,
    title: p.title,
    version: p.version,
    source: p.source,
    baseUrl: p.baseUrl || "",
    auth: {
      type: auth.type || "none",
      headerName: auth.headerName || "",
      username: auth.username || "",
      valueMasked: maskSecret(decrypt(auth.valueEncrypted)),
      passwordMasked: maskSecret(decrypt(auth.passwordEncrypted)),
    },
    // Every scheme the API accepts, so the UI can offer "test with this one".
    // Secrets go out masked; saving a masked value back means "unchanged".
    authSchemes: (p.authSchemes || []).map((sc) => ({
      name: sc.name,
      type: sc.type || "none",
      headerName: sc.headerName || "",
      username: sc.username || "",
      valueMasked: maskSecret(decrypt(sc.valueEncrypted)),
      passwordMasked: maskSecret(decrypt(sc.passwordEncrypted)),
      configured: Boolean(sc.valueEncrypted || sc.passwordEncrypted),
    })),
    // Non-secret vars show their value; secret ones are masked.
    variables: (p.variables || []).map((v) => ({
      key: v.key,
      secret: !!v.secret,
      value: v.secret ? maskSecret(decrypt(v.value)) : v.value,
    })),
    github: p.github || {},
    updatedAt: p.updatedAt,
  };
}

// Paste a Swagger/OpenAPI spec → creates/updates an ApiProject + its endpoints.
async function importProjectSpec(req, res) {
  if (!requireCompany(req, res)) return;
  const { specText, projectId } = req.body;
  if (!specText) {
    return res.status(400).json({ message: "specText is required" });
  }
  try {
    const result = await openApiService.importSpec({
      specText,
      projectId, // optional — re-import into an existing project
      userId: req.user._id,
      companyId: req.user.companyId,
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("importProjectSpec error:", err);
    res.status(status).json({ message: err.message || "Import failed" });
  }
}

async function listProjects(req, res) {
  if (!requireCompany(req, res)) return;
  const projects = await ApiProject.find({
    companyId: req.user.companyId,
  }).sort({ updatedAt: -1 });
  res.json(projects.map(serializeProject));
}

async function getProjectDocs(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await ApiProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });
  const docs = await Doc.find({
    companyId: req.user.companyId,
    projectId: project._id,
  }).sort({ section: 1, path: 1 });
  res.json({ project: serializeProject(project), docs });
}

// Set (or clear) a custom example body on one endpoint. The QA generator uses
// it as the base for the happy_path case; send null/{} to clear it.
async function updateDocBody(req, res) {
  if (!requireCompany(req, res)) return;
  const { exampleBody } = req.body;
  const doc = await Doc.findOne({
    _id: req.params.docId,
    companyId: req.user.companyId,
  });
  if (!doc) return res.status(404).json({ message: "Endpoint not found" });

  // Treat null / empty object as "no override" so the generator falls back to
  // building the body from the schema.
  const isEmpty =
    exampleBody == null ||
    (typeof exampleBody === "object" &&
      !Array.isArray(exampleBody) &&
      Object.keys(exampleBody).length === 0);
  doc.exampleBody = isEmpty ? undefined : exampleBody;
  doc.updatedAt = new Date();
  await doc.save();
  res.json(doc);
}

// Set baseUrl + auth + environment variables on a project. Secrets are
// encrypted at rest.
async function setProjectAuth(req, res) {
  if (!requireCompany(req, res)) return;
  const { baseUrl, auth = {}, variables } = req.body;
  const project = await ApiProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  if (baseUrl != null) project.baseUrl = baseUrl;
  project.auth = {
    type: auth.type || "none",
    headerName: auth.headerName || "",
    username: auth.username || "",
    // Only overwrite the secret when a new value is supplied.
    valueEncrypted: auth.value
      ? encrypt(auth.value)
      : project.auth?.valueEncrypted || "",
    passwordEncrypted: auth.password
      ? encrypt(auth.password)
      : project.auth?.passwordEncrypted || "",
  };

  // Environment variables: encrypt secret ones; keep an unchanged secret if the
  // client sent a blank/masked value (so editing other fields doesn't wipe it).
  if (Array.isArray(variables)) {
    const prev = new Map((project.variables || []).map((v) => [v.key, v]));
    project.variables = variables
      .filter((v) => v && v.key)
      .map((v) => {
        if (!v.secret) return { key: v.key, value: v.value ?? "", secret: false };
        const incoming = v.value;
        const looksMasked = !incoming || /\*/.test(incoming);
        const value = looksMasked
          ? prev.get(v.key)?.value || ""
          : encrypt(incoming);
        return { key: v.key, value, secret: true };
      });
  }

  // Per-scheme credentials. Same "blank or masked means unchanged" rule as
  // everywhere else, so filling in one scheme never wipes another's token.
  if (Array.isArray(req.body?.authSchemes)) {
    const prev = new Map((project.authSchemes || []).map((sc) => [sc.name, sc]));
    project.authSchemes = req.body.authSchemes
      .filter((sc) => sc && sc.name)
      .map((sc) => {
        const before = prev.get(sc.name) || {};
        const incoming = String(sc.value ?? "");
        const looksMasked = !incoming.trim() || /\*/.test(incoming);
        const incomingPw = String(sc.password ?? "");
        const pwMasked = !incomingPw.trim() || /\*/.test(incomingPw);
        return {
          name: sc.name,
          type: sc.type || before.type || "none",
          headerName: sc.headerName ?? before.headerName ?? "",
          username: sc.username ?? before.username ?? "",
          valueEncrypted: looksMasked
            ? before.valueEncrypted || ""
            : encrypt(incoming),
          passwordEncrypted: pwMasked
            ? before.passwordEncrypted || ""
            : encrypt(incomingPw),
        };
      });
  }

  project.updatedAt = new Date();
  await project.save();
  res.json(serializeProject(project));
}

// One Postman collection for a whole section, ready for Newman.
async function getProjectSectionCollection(req, res) {
  if (!requireCompany(req, res)) return;
  const section = req.query.section;
  if (!section) {
    return res.status(400).json({ message: "section query param required" });
  }
  const project = await ApiProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });
  const docs = await Doc.find({
    companyId: req.user.companyId,
    projectId: project._id,
    section,
  });
  if (docs.length === 0) {
    return res.status(404).json({ message: "No endpoints in this section" });
  }
  const collection = openApiService.buildSectionCollection({
    section,
    docs,
    baseUrl: project.baseUrl,
  });
  res.json(collection);
}

async function findBugsForSection(req, res) {
  if (!requireCompany(req, res)) return;
  const { id, section } = req.params;
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await apiQAService.findBugsForSection({
      projectId: id,
      section: decodeURIComponent(section),
      userId: req.user._id,
      companyId: req.user.companyId,
      anthropicClient,
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("findBugsForSection error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function listSuiteRuns(req, res) {
  if (!requireCompany(req, res)) return;
  const { id } = req.params;
  const { section } = req.query;
  const filter = { companyId: req.user.companyId, projectId: id };
  if (section) filter.section = decodeURIComponent(section);
  const runs = await SuiteRun.find(filter, { executions: 0 }).sort({ createdAt: -1 });
  res.json(runs);
}

async function getSuiteRun(req, res) {
  if (!requireCompany(req, res)) return;
  const run = await SuiteRun.findOne({ _id: req.params.id, companyId: req.user.companyId });
  if (!run) return res.status(404).json({ message: "Suite run not found" });
  res.json(run);
}

async function deleteProject(req, res) {
  if (!requireCompany(req, res)) return;
  const { id } = req.params;
  const project = await ApiProject.findOne({ _id: id, companyId: req.user.companyId });
  if (!project) return res.status(404).json({ message: "Project not found" });
  await Doc.deleteMany({ apiProjectId: id });
  await Bug.deleteMany({ apiProjectId: id });
  await ApiProject.deleteOne({ _id: id });
  res.json({ deleted: true });
}

// ---------- GitHub-connected spec flow ----------

// Step 1: user picks a connected repo and types the spec file name. We scan
// the repo and return matching candidates so they confirm the right file.
async function discoverGithubSpec(req, res) {
  if (!requireCompany(req, res)) return;
  const { installationId, owner, repo, filename } = req.body;
  if (!installationId || !owner || !repo) {
    return res
      .status(400)
      .json({ message: "installationId, owner and repo are required" });
  }
  try {
    const octokit = await getOctokit(Number(installationId));
    const candidates = await findSpecCandidates(octokit, owner, repo, filename);
    res.json({ candidates });
  } catch (err) {
    console.error("discoverGithubSpec error:", err);
    res
      .status(err.status || 500)
      .json({ message: err.message || "Could not scan repo" });
  }
}

// Step 2: fetch the confirmed spec file from the repo and import it, stamping
// the github link so it can be re-synced later. Pass projectId to re-import
// into an existing project.
async function importGithubSpec(req, res) {
  if (!requireCompany(req, res)) return;
  const { installationId, owner, repo, specPath, projectId } = req.body;
  if (!installationId || !owner || !repo || !specPath) {
    return res.status(400).json({
      message: "installationId, owner, repo and specPath are required",
    });
  }
  try {
    const octokit = await getOctokit(Number(installationId));
    const defaultBranch = await getDefaultBranch(octokit, owner, repo);
    const specText = await fetchFileAtRef(
      octokit,
      owner,
      repo,
      specPath,
      defaultBranch
    );
    if (!specText) {
      return res
        .status(404)
        .json({ message: `Could not read ${specPath} in ${owner}/${repo}` });
    }
    const result = await openApiService.importSpec({
      specText,
      projectId,
      userId: req.user._id,
      companyId: req.user.companyId,
      github: {
        owner,
        repo,
        specPath,
        installationId: Number(installationId),
        defaultBranch,
      },
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || err.status || 500;
    console.error("importGithubSpec error:", err);
    res.status(status).json({ message: err.message || "Import failed" });
  }
}

// Step 3: "Sync" button — re-fetch the linked spec and re-import in place so
// the project picks up whatever changed in the repo.
async function syncGithubSpec(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await ApiProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  const gh = project.github || {};
  if (!gh.owner || !gh.repo || !gh.specPath || !gh.installationId) {
    return res
      .status(400)
      .json({ message: "Project is not linked to a GitHub spec" });
  }
  try {
    const octokit = await getOctokit(Number(gh.installationId));
    const branch =
      gh.defaultBranch || (await getDefaultBranch(octokit, gh.owner, gh.repo));
    const specText = await fetchFileAtRef(
      octokit,
      gh.owner,
      gh.repo,
      gh.specPath,
      branch
    );
    if (!specText) {
      return res.status(404).json({
        message: `Could not read ${gh.specPath} in ${gh.owner}/${gh.repo}`,
      });
    }
    const result = await openApiService.importSpec({
      specText,
      projectId: project._id,
      userId: req.user._id,
      companyId: req.user.companyId,
      github: {
        owner: gh.owner,
        repo: gh.repo,
        specPath: gh.specPath,
        installationId: Number(gh.installationId),
        defaultBranch: branch,
      },
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || err.status || 500;
    console.error("syncGithubSpec error:", err);
    res.status(status).json({ message: err.message || "Sync failed" });
  }
}


// ---------- Saved test suites (smoke / regression) per endpoint ----------

// Create (or regenerate) one kind of suite for ONE endpoint. This is the
// "Create test" button on the endpoint row.
async function generateSuite(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  const kind = req.body?.kind;
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    // No kind given → generate both, which is what the button does.
    const kinds = kind ? [kind] : ["smoke", "regression"];
    const suites = [];
    for (const k of kinds) {
      suites.push(
        await apiSuiteService.generateSuite({
          docId,
          kind: k,
          userId: req.user._id,
          companyId: req.user.companyId,
          anthropicClient,
        })
      );
    }
    res.status(201).json({ suites });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("generateSuite error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

// Same thing for every endpoint in a section. Slow by nature (one model call
// per endpoint per kind), so it reports what succeeded AND what didn't rather
// than failing the whole batch on one bad endpoint.
async function generateSectionSuites(req, res) {
  if (!requireCompany(req, res)) return;
  // Two shapes of URL reach here: an imported spec (:id) and a connected GitHub
  // repo (:owner/:repo). The service takes whichever scope is present.
  const { id, owner, repo, section } = req.params;
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await apiSuiteService.generateSectionSuites({
      projectId: id || null,
      owner,
      repo,
      section,
      kinds: req.body?.kind ? [req.body.kind] : ["smoke", "regression"],
      userId: req.user._id,
      companyId: req.user.companyId,
      anthropicClient,
    });
    res.status(201).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("generateSectionSuites error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

// Every suite of a project — what the tests page renders, grouped
// section -> endpoint -> tests by the client.
async function listSuites(req, res) {
  if (!requireCompany(req, res)) return;
  try {
    const suites = await apiSuiteService.listProjectSuites({
      projectId: req.params.id || null,
      owner: req.params.owner,
      repo: req.params.repo,
      companyId: req.user.companyId,
    });
    res.json(suites);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("listSuites error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function runSuite(req, res) {
  if (!requireCompany(req, res)) return;
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await apiSuiteService.runSuite({
      suiteId: req.params.suiteId,
      companyId: req.user.companyId,
      anthropicClient,
      authSchemeName: req.body?.authSchemeName || "",
    });
    res.json({ summary: result.summary, results: result.results });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("runSuite error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

// Change what one test covers, from a plain-language instruction.
async function refineSuiteCase(req, res) {
  if (!requireCompany(req, res)) return;
  const { suiteId, caseId } = req.params;
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await apiSuiteService.refineCase({
      suiteId,
      caseId,
      instruction: req.body?.instruction,
      companyId: req.user.companyId,
      anthropicClient,
    });
    res.json({
      case: result.case,
      added: result.added,
      removed: result.removed,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("refineSuiteCase error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

// Add ONE test by hand: blank, or written from a sentence.
async function createSuiteCase(req, res) {
  if (!requireCompany(req, res)) return;
  try {
    const instruction = req.body?.instruction || "";
    const result = await apiSuiteService.createCase({
      suiteId: req.params.suiteId,
      instruction,
      companyId: req.user.companyId,
      anthropicClient: instruction.trim()
        ? await getUserAnthropicClient(req.user._id)
        : null,
    });
    res.status(201).json({ case: result.case });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("createSuiteCase error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function deleteSuiteCase(req, res) {
  if (!requireCompany(req, res)) return;
  try {
    await apiSuiteService.deleteCase({
      suiteId: req.params.suiteId,
      caseId: req.params.caseId,
      companyId: req.user.companyId,
    });
    res.json({ success: true });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("deleteSuiteCase error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function deleteSuite(req, res) {
  if (!requireCompany(req, res)) return;
  const ApiSuite = require("../model/ApiSuiteModel");
  const del = await ApiSuite.deleteOne({
    _id: req.params.suiteId,
    companyId: req.user.companyId,
  });
  if (!del.deletedCount) {
    return res.status(404).json({ message: "Suite not found" });
  }
  res.json({ success: true });
}


// Per-endpoint variables. Same encryption + "blank means unchanged" rules as
// the global ones, so a token pasted here is never stored in the clear and is
// never wiped by editing a neighbouring field.
async function setDocVariables(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  const { variables } = req.body;

  const doc = await Doc.findOne({ _id: docId, companyId: req.user.companyId });
  if (!doc) return res.status(404).json({ message: "Endpoint not found" });

  if (Array.isArray(variables)) {
    const prev = new Map((doc.variables || []).map((v) => [v.key, v]));
    doc.variables = variables
      .filter((v) => v && typeof v.key === "string" && v.key.trim())
      .map((v) => {
        const key = v.key.trim();
        if (!v.secret) {
          return { key, value: String(v.value ?? ""), secret: false };
        }
        const incoming = String(v.value ?? "");
        const looksMasked = !incoming.trim() || /\*/.test(incoming);
        return {
          key,
          value: looksMasked ? prev.get(key)?.value || "" : encrypt(incoming),
          secret: true,
        };
      });
    await doc.save();
  }

  res.json({
    variables: (doc.variables || []).map((v) => ({
      key: v.key,
      value: v.secret ? maskSecret(decrypt(v.value)) : v.value,
      secret: Boolean(v.secret),
    })),
  });
}

// What a test run will actually resolve for this endpoint: the global set, the
// endpoint's own overrides, and which of the two each key ends up coming from.
// This is the "why am I still getting a 401" answer, in one call.
async function getDocVariables(req, res) {
  if (!requireCompany(req, res)) return;
  const doc = await Doc.findOne({
    _id: req.params.docId,
    companyId: req.user.companyId,
  });
  if (!doc) return res.status(404).json({ message: "Endpoint not found" });

  let globalVars = [];
  let authType = "none";
  let baseUrl = "";
  if (doc.projectId) {
    const project = await ApiProject.findOne({
      _id: doc.projectId,
      companyId: req.user.companyId,
    });
    globalVars = project?.variables || [];
    authType = project?.auth?.type || "none";
    baseUrl = project?.baseUrl || "";
  } else {
    const cfg = await ApiQaConfig.findOne({
      companyId: req.user.companyId,
      owner: doc.owner,
      repo: doc.repo,
    });
    globalVars = cfg?.variables || [];
    authType = cfg?.auth?.type || "none";
    baseUrl = cfg?.baseUrl || "";
  }

  const docKeys = new Set((doc.variables || []).map((v) => v.key));
  const mask = (v) => (v.secret ? maskSecret(decrypt(v.value)) : v.value);

  res.json({
    scope: doc.projectId ? "project" : "repo",
    baseUrl,
    authType,
    // The endpoint itself, so one call is enough to render the whole
    // per-endpoint config block (variables + request body) anywhere.
    method: doc.method,
    path: doc.path,
    exampleBody: doc.exampleBody ?? null,
    global: globalVars.map((v) => ({
      key: v.key,
      value: mask(v),
      secret: Boolean(v.secret),
      overridden: docKeys.has(v.key),
    })),
    endpoint: (doc.variables || []).map((v) => ({
      key: v.key,
      value: mask(v),
      secret: Boolean(v.secret),
    })),
  });
}

module.exports = {
  getConfig,
  upsertConfig,
  importProjectSpec,
  discoverGithubSpec,
  importGithubSpec,
  syncGithubSpec,
  listProjects,
  getProjectDocs,
  updateDocBody,
  deleteProject,
  setProjectAuth,
  getProjectSectionCollection,
  findBugs,
  findBugsForSection,
  getBugs,
  deleteBug,
  updateBugStatus,
  getCollection,
  listRuns,
  getRun,
  listSuiteRuns,
  getSuiteRun,
  generateSuite,
  generateSectionSuites,
  listSuites,
  runSuite,
  refineSuiteCase,
  createSuiteCase,
  deleteSuiteCase,
  deleteSuite,
  getDocVariables,
  setDocVariables,
};
