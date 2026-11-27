import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fullLeakCheck, isValidationCommandAllowed, normalizeEvidenceLink, sanitizePayload } from "./sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const BUNDLED_EXP_DIR = path.join(PLUGIN_ROOT, "assets", "experiences");

function normalizeExperienceType(rawType) {
  const val = String(rawType || "").trim().toLowerCase();
  if (val === "fix") return "Fix";
  if (val === "knowledge") return "Knowledge";
  return "Rule";
}

function getFileNameForType(type) {
  const t = normalizeExperienceType(type);
  if (t === "Fix") return "fixes.json";
  if (t === "Knowledge") return "knowledge.json";
  return "rules.json";
}

export function getEvoHome(overrideHome) {
  return overrideHome || process.env.COPILOT_EVO_HOME || path.join(os.homedir(), ".copilot", "evo");
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function stripLocalSyncFields(asset) {
  if (!asset || typeof asset !== "object") return asset;
  const { pendingSuccessDelta, pendingFailureDelta, pendingRecallDelta, ...rest } = asset;
  return rest;
}

function mergeById(existing, incoming, options = {}) {
  const { updateExisting = false } = options;
  const map = new Map(existing.map((item, idx) => [item.id, idx]));
  const merged = [...existing];
  let added = 0;
  let updated = 0;
  for (const rawItem of incoming) {
    if (!rawItem?.id) continue;
    const item = stripLocalSyncFields(rawItem);
    const existingIdx = map.get(item.id);
    if (existingIdx === undefined) {
      map.set(item.id, merged.length);
      merged.push(item);
      added++;
      continue;
    }
    if (updateExisting) {
      const cur = merged[existingIdx];
      const pendingSucc = cur.pendingSuccessDelta || 0;
      const pendingFail = cur.pendingFailureDelta || 0;
      const pendingRecall = cur.pendingRecallDelta || 0;
      const baseSucc = Math.max(0, (cur.successCount || 0) - pendingSucc);
      const baseFail = Math.max(0, (cur.failureCount || 0) - pendingFail);
      const baseRecall = Math.max(0, (cur.recallCount || 0) - pendingRecall);
      const nextSucc = Math.max(item.successCount || 0, baseSucc) + pendingSucc;
      const nextFail = Math.max(item.failureCount || 0, baseFail) + pendingFail;
      const nextRecall = Math.max(item.recallCount || 0, baseRecall) + pendingRecall;
      const incomingNewer =
        item.updatedAt && (!cur.updatedAt || Date.parse(item.updatedAt) > Date.parse(cur.updatedAt));
      const nextItem = incomingNewer ? { ...cur, ...item } : { ...cur };
      nextItem.successCount = nextSucc;
      nextItem.failureCount = nextFail;
      if (nextRecall > 0) nextItem.recallCount = nextRecall;
      if (pendingSucc) nextItem.pendingSuccessDelta = pendingSucc;
      if (pendingFail) nextItem.pendingFailureDelta = pendingFail;
      if (pendingRecall) nextItem.pendingRecallDelta = pendingRecall;
      if (JSON.stringify(nextItem) !== JSON.stringify(cur)) {
        merged[existingIdx] = nextItem;
        updated++;
      }
    }
  }
  return { merged, added, updated };
}

export function initStore(options = {}) {
  const evoHome = getEvoHome(options.evoHome);
  const bundledDir = options.bundledDir || BUNDLED_EXP_DIR;
  fs.mkdirSync(evoHome, { recursive: true });

  const rulesPath = path.join(evoHome, "rules.json");
  const fixesPath = path.join(evoHome, "fixes.json");
  const knowledgePath = path.join(evoHome, "knowledge.json");
  const configPath = path.join(evoHome, "config.json");

  const starterRules = readJsonSafe(path.join(bundledDir, "starter-rules.json"), []);
  const starterKnowledge = readJsonSafe(path.join(bundledDir, "starter-knowledge.json"), []);

  const currentRules = readJsonSafe(rulesPath, []);
  const currentFixes = readJsonSafe(fixesPath, []);
  const currentKnowledge = readJsonSafe(knowledgePath, []);

  const { merged: mergedRules } = mergeById(currentRules, starterRules);
  const { merged: mergedKnowledge } = mergeById(currentKnowledge, starterKnowledge);

  if (!fs.existsSync(rulesPath) || mergedRules.length !== currentRules.length) {
    writeJson(rulesPath, mergedRules);
  }
  if (!fs.existsSync(fixesPath)) {
    writeJson(fixesPath, currentFixes);
  }
  if (!fs.existsSync(knowledgePath) || mergedKnowledge.length !== currentKnowledge.length) {
    writeJson(knowledgePath, mergedKnowledge);
  }
  if (!fs.existsSync(configPath)) {
    writeJson(configPath, {
      syncRepoPath: "",
      syncRepo: "",
      strictGuardrails: false,
      autoInjectLimit: 3,
    });
  }
  return evoHome;
}

export function loadStore(evoHome) {
  return {
    rules: readJsonSafe(path.join(evoHome, "rules.json"), []),
    fixes: readJsonSafe(path.join(evoHome, "fixes.json"), []),
    knowledge: readJsonSafe(path.join(evoHome, "knowledge.json"), []),
    config: readJsonSafe(path.join(evoHome, "config.json"), {
      syncRepoPath: "",
      syncRepo: "",
      strictGuardrails: false,
      autoInjectLimit: 3,
    }),
  };
}

function saveConfig(evoHome, patch) {
  const current = loadStore(evoHome).config;
  const next = { ...current, ...patch };
  writeJson(path.join(evoHome, "config.json"), next);
  return next;
}

let eventSessionContextProvider = null;

export function setEventSessionContext(provider) {
  eventSessionContextProvider = provider || null;
}

function getEventSessionContext() {
  try {
    const raw = typeof eventSessionContextProvider === "function" ? eventSessionContextProvider() : eventSessionContextProvider;
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    if (raw.sessionId) out.sessionId = String(raw.sessionId).slice(0, 64);
    if (raw.sessionName) out.sessionName = String(raw.sessionName).slice(0, 60);
    if (raw.repo) out.repo = String(raw.repo).slice(0, 120);
    if (raw.project) out.project = String(raw.project).slice(0, 120);
    return out;
  } catch {
    return {};
  }
}

const MAX_EVENTS_RETENTION = 500;
const PRUNE_TRIGGER_BYTES = 180 * 1024;

export function appendEvent(evoHome, event, options = {}) {
  fs.mkdirSync(evoHome, { recursive: true });
  const maxEvents = options.maxEvents || MAX_EVENTS_RETENTION;
  const cleanEvent = sanitizePayload({
    ts: new Date().toISOString(),
    ...getEventSessionContext(),
    ...event,
  });
  const eventsPath = path.join(evoHome, "events.jsonl");
  fs.appendFileSync(eventsPath, `${JSON.stringify(cleanEvent)}\n`, "utf8");
  try {
    const stat = fs.statSync(eventsPath);
    if (stat.size > PRUNE_TRIGGER_BYTES || options.forcePruneCheck) {
      const lines = fs.readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      if (lines.length > maxEvents) {
        fs.writeFileSync(eventsPath, `${lines.slice(-maxEvents).join("\n")}\n`, "utf8");
      }
    }
  } catch {
    // Ignore best-effort pruning errors.
  }
  return cleanEvent;
}

export function countEvents(evoHome) {
  const eventsPath = path.join(evoHome, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return 0;
  const content = fs.readFileSync(eventsPath, "utf8").trim();
  return content ? content.split(/\r?\n/).length : 0;
}

export function readRecentEvents(evoHome, limit = 50) {
  const eventsPath = path.join(evoHome, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, "utf8").trim();
  if (!content) return [];
  const lines = content.split(/\r?\n/).slice(-limit).reverse();
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed log line.
    }
  }
  return events;
}

const MAX_PENDING_CAPTURES = 10;

export function loadPendingCaptures(evoHome) {
  const list = readJsonSafe(path.join(evoHome, "pending-captures.json"), []);
  return Array.isArray(list) ? list : [];
}

export function addPendingCapture(evoHome, capture) {
  if (!capture || !capture.prompt) return null;
  const filePath = path.join(evoHome, "pending-captures.json");
  const list = loadPendingCaptures(evoHome);
  const id = String(capture.id || `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const clean = sanitizePayload({
    id,
    ts: new Date().toISOString(),
    sessionId: String(capture.sessionId || "").slice(0, 64),
    sessionName: String(capture.sessionName || "").slice(0, 60),
    repo: String(capture.repo || "").slice(0, 120),
    turnIndex: Number(capture.turnIndex || 0),
    reason: String(capture.reason || "revision").slice(0, 60),
    prompt: String(capture.prompt || "").slice(0, 280),
    assistantSummary: String(capture.assistantSummary || "").slice(0, 280),
    targets: Array.isArray(capture.targets) ? capture.targets.slice(0, 5) : [],
    recalledIds: Array.isArray(capture.recalledIds) ? capture.recalledIds.slice(0, 5) : [],
  });
  const deduped = list.filter(
    (item) => !(item.sessionId && item.sessionId === clean.sessionId && item.turnIndex === clean.turnIndex)
  );
  const next = [clean, ...deduped].slice(0, MAX_PENDING_CAPTURES);
  writeJson(filePath, next);
  return clean;
}

export function removePendingCapture(evoHome, captureId) {
  if (!captureId) return { ok: false, error: "Capture ID is required." };
  const filePath = path.join(evoHome, "pending-captures.json");
  const list = loadPendingCaptures(evoHome);
  const next = list.filter((item) => item.id !== captureId);
  if (next.length === list.length) {
    return { ok: false, error: `Pending capture not found: ${captureId}` };
  }
  writeJson(filePath, next);
  return { ok: true, removedId: captureId };
}

export function formatAssetPreview(asset) {
  if (!asset) return "";
  const kindLabel = normalizeExperienceType(asset.type);
  const repoLabel = asset.repoScope && asset.repoScope !== "*" ? ` repo:${asset.repoScope}` : " repo:*";
  const lines = [
    `[EXP · ${kindLabel}:${asset.id}] (${asset.scope}${repoLabel}) ${asset.title}`,
    `Summary: ${asset.summary}`,
    `Signals: ${(asset.signals || []).join(", ") || "none"}`,
  ];
  const ruleRef = asset.ruleId;
  if (ruleRef) lines.push(`Derived from Rule: ${ruleRef}`);
  if (asset.parentId) lines.push(`Parent Experience: ${asset.parentId}`);
  if (asset.supersedes) lines.push(`Supersedes: ${asset.supersedes}`);
  if (asset.solution) lines.push(`Solution: ${asset.solution}`);
  if (asset.strategy?.length) {
    lines.push(kindLabel === "Knowledge" ? "Key Takeaways:" : "Steps:");
    asset.strategy.forEach((step, idx) => lines.push(`  ${idx + 1}. ${step}`));
  }
  if (asset.validation?.length) {
    lines.push(`Validation: ${asset.validation.join(", ")}`);
  }
  if (asset.references?.length) {
    lines.push("Evidence:");
    asset.references.forEach((ref) => lines.push(`  - ${ref.label || ref.url}: ${ref.url}`));
  }
  return lines.join("\n");
}

export function normalizeRepoSlug(raw) {
  if (!raw || typeof raw !== "string") return "*";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "global") return "*";
  const cleaned = trimmed
    .replace(/^https?:\/\/(?:[^@/\s]+@)?[^/\s]+\//i, "")
    .replace(/^git@[^:\s]+:/i, "")
    .replace(/^ssh:\/\/(?:[^@/\s]+@)?[^/\s]+\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned) ? cleaned : "*";
}

export function detectRepoSlug(workingDirectory) {
  if (!workingDirectory || !fs.existsSync(workingDirectory)) return "";
  try {
    const remote = execFileSync("git", ["-C", workingDirectory, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const slug = normalizeRepoSlug(remote);
    return slug === "*" ? "" : slug;
  } catch {
    return "";
  }
}

export function computeGdiBreakdown(asset, allAssets = [], nowMs = Date.now()) {
  const success = Math.max(0, Number(asset?.successCount || 0));
  const failure = Math.max(0, Number(asset?.failureCount || 0));
  const totalRuns = success + failure;
  const winRate = totalRuns > 0 ? Math.round((success / totalRuns) * 100) : 100;

  // 1. Intrinsic Quality (35%): completeness, actionable steps/takeaways, signals, validation.
  const kind = normalizeExperienceType(asset?.type);
  let quality = 25;
  if (String(asset?.title || "").trim().length >= 8) quality += 15;
  if (String(asset?.summary || "").trim().length >= 20) quality += 15;
  if (Array.isArray(asset?.signals) && asset.signals.length >= 2) quality += 15;
  const hasDetail =
    (Array.isArray(asset?.strategy) && asset.strategy.length >= (kind === "Knowledge" ? 1 : 2)) ||
    String(asset?.solution || "").trim().length >= 15 ||
    (kind === "Knowledge" && String(asset?.summary || "").trim().length >= 60);
  if (hasDetail) quality += 15;
  if (
    (Array.isArray(asset?.validation) && asset.validation.length > 0) ||
    (Array.isArray(asset?.references) && asset.references.length > 0) ||
    (kind === "Knowledge" &&
      String(asset?.summary || "").trim().length >= 45 &&
      ((Array.isArray(asset?.strategy) && asset.strategy.length >= 1) ||
        String(asset?.solution || "").trim().length >= 15))
  ) {
    quality += 15;
  }
  quality = Math.min(100, quality);

  // 2. Usage & Reliability (30%): reuses, win rate, and priority.
  const reusePart = Math.min(60, Math.log2(1 + success) * 20);
  const winPart = totalRuns > 0 ? (success / totalRuns) * 35 : 20;
  const priorityPart = Math.min(10, Math.max(0, Number(asset?.priority || 0)));
  const penalty = Math.min(35, failure * 12);
  const reliability = Math.max(5, Math.min(100, Math.round(reusePart + winPart + priorityPart - penalty)));

  // 3. Lineage & Evolution Signal (20%): links + team promotion + derivations.
  let lineage = asset?.scope === "team" ? 40 : asset?.scope === "starter" ? 30 : 20;
  if (asset?.ruleId || asset?.parentId || asset?.supersedes) lineage += 25;
  const hasChildren = allAssets.some(
    (a) => a.id !== asset?.id && (a.ruleId === asset?.id || a.parentId === asset?.id)
  );
  if (hasChildren) lineage += 25;
  if (asset?.pinned) lineage += 10;
  lineage = Math.min(100, lineage);

  // 4. Freshness (15%): recency of update/use.
  let freshness = 55;
  if (asset?.updatedAt) {
    const ageDays = Math.max(0, (nowMs - Date.parse(asset.updatedAt)) / 86400000);
    if (Number.isFinite(ageDays)) freshness = Math.round(100 / (1 + ageDays / 14));
  }

  const weighted = quality * 0.35 + reliability * 0.3 + lineage * 0.2 + freshness * 0.15 + (asset?.pinned ? 15 : 0);
  const score = Math.round(Math.max(1, Math.min(100, weighted)) * 10) / 10;
  const tier = score >= 80 ? "S" : score >= 65 ? "A" : score >= 45 ? "B" : "C";

  return { score, tier, quality, reliability, lineage, freshness, winRate };
}

export function computeGdiScore(asset, allAssets = [], nowMs = Date.now()) {
  if (typeof allAssets === "number") {
    return computeGdiBreakdown(asset, [], allAssets).score;
  }
  return computeGdiBreakdown(asset, allAssets, nowMs).score;
}

export function getAssetRelationships(asset, allAssets) {
  if (!asset) return { parent: null, rule: null, supersedes: null, children: [], supersededBy: [], sharedSignals: [] };
  const byId = new Map(allAssets.map((item) => [item.id, item]));
  const pickSummary = (item) => (item ? { id: item.id, type: item.type, title: item.title, scope: item.scope } : null);
  const mySignals = new Set((asset.signals || []).map((s) => String(s).toLowerCase()));
  const sharedSignals = [];
  if (mySignals.size > 0) {
    for (const other of allAssets) {
      if (other.id === asset.id) continue;
      const overlap = (other.signals || []).filter((s) => mySignals.has(String(s).toLowerCase()));
      if (overlap.length > 0) {
        sharedSignals.push({ ...pickSummary(other), overlap });
      }
    }
    sharedSignals.sort((a, b) => b.overlap.length - a.overlap.length);
  }
  return {
    rule: asset.ruleId ? pickSummary(byId.get(asset.ruleId)) : null,
    parent: asset.parentId ? pickSummary(byId.get(asset.parentId)) : null,
    supersedes: asset.supersedes ? pickSummary(byId.get(asset.supersedes)) : null,
    children: allAssets
      .filter((item) => item.id !== asset.id && (item.parentId === asset.id || item.ruleId === asset.id))
      .map(pickSummary),
    supersededBy: allAssets
      .filter((item) => item.id !== asset.id && item.supersedes === asset.id)
      .map(pickSummary),
    sharedSignals: sharedSignals.slice(0, 6),
  };
}

export function recordAssetOutcome(evoHome, assetIds = [], outcome = "success", reason = "auto") {
  const uniqueIds = Array.from(new Set(assetIds.filter(Boolean)));
  if (!uniqueIds.length) return [];
  const rulesPath = path.join(evoHome, "rules.json");
  const fixesPath = path.join(evoHome, "fixes.json");
  const knowledgePath = path.join(evoHome, "knowledge.json");
  const rules = readJsonSafe(rulesPath, []);
  const fixes = readJsonSafe(fixesPath, []);
  const knowledge = readJsonSafe(knowledgePath, []);
  const idSet = new Set(uniqueIds);
  const updated = [];
  let rulesDirty = false;
  let fixesDirty = false;
  let knowledgeDirty = false;

  const apply = (list, markDirty) => {
    for (let i = 0; i < list.length; i++) {
      if (!idSet.has(list[i].id)) continue;
      const next = { ...list[i] };
      if (outcome === "failure") {
        next.failureCount = (next.failureCount || 0) + 1;
        next.pendingFailureDelta = (next.pendingFailureDelta || 0) + 1;
      } else {
        next.successCount = (next.successCount || 0) + 1;
        next.pendingSuccessDelta = (next.pendingSuccessDelta || 0) + 1;
      }
      next.updatedAt = new Date().toISOString();
      list[i] = next;
      updated.push(next.id);
      markDirty();
    }
  };

  apply(rules, () => { rulesDirty = true; });
  apply(fixes, () => { fixesDirty = true; });
  apply(knowledge, () => { knowledgeDirty = true; });
  if (rulesDirty) writeJson(rulesPath, rules);
  if (fixesDirty) writeJson(fixesPath, fixes);
  if (knowledgeDirty) writeJson(knowledgePath, knowledge);
  if (updated.length) {
    appendEvent(evoHome, { event: `auto_${outcome}`, assetIds: updated, reason });
  }
  return updated;
}

export function recordAssetRecalls(evoHome, assetIds = []) {
  const uniqueIds = Array.from(new Set(assetIds.filter(Boolean)));
  if (!uniqueIds.length) return [];
  const rulesPath = path.join(evoHome, "rules.json");
  const fixesPath = path.join(evoHome, "fixes.json");
  const knowledgePath = path.join(evoHome, "knowledge.json");
  const rules = readJsonSafe(rulesPath, []);
  const fixes = readJsonSafe(fixesPath, []);
  const knowledge = readJsonSafe(knowledgePath, []);
  const idSet = new Set(uniqueIds);
  const updated = [];
  let rulesDirty = false;
  let fixesDirty = false;
  let knowledgeDirty = false;

  const apply = (list, markDirty) => {
    for (let i = 0; i < list.length; i++) {
      if (!idSet.has(list[i].id)) continue;
      const next = { ...list[i] };
      next.recallCount = (next.recallCount || 0) + 1;
      next.pendingRecallDelta = (next.pendingRecallDelta || 0) + 1;
      list[i] = next;
      updated.push(next.id);
      markDirty();
    }
  };

  apply(rules, () => { rulesDirty = true; });
  apply(fixes, () => { fixesDirty = true; });
  apply(knowledge, () => { knowledgeDirty = true; });
  if (rulesDirty) writeJson(rulesPath, rules);
  if (fixesDirty) writeJson(fixesPath, fixes);
  if (knowledgeDirty) writeJson(knowledgePath, knowledge);
  return updated;
}

export function detectSourceLabel(workingDirectory) {
  if (!workingDirectory) return "chat";
  const slug = detectRepoSlug(workingDirectory);
  if (slug) return slug;
  try {
    execFileSync("git", ["-C", workingDirectory, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return "local-git";
  } catch {
    return "chat";
  }
}

function detectGhLogin() {
  const candidates = [
    process.env.GH_CONFIG_DIR ? path.join(process.env.GH_CONFIG_DIR, "hosts.yml") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "GitHub CLI", "hosts.yml") : null,
    path.join(os.homedir(), ".config", "gh", "hosts.yml"),
  ].filter(Boolean);
  for (const hostsFile of candidates) {
    try {
      if (!fs.existsSync(hostsFile)) continue;
      const content = fs.readFileSync(hostsFile, "utf8");
      const githubBlock = content.match(/^github\.com:\s*\r?\n((?:[ \t]+.*\r?\n?)*)/m);
      const section = githubBlock ? githubBlock[1] : content;
      const userMatch = section.match(/^\s+user:\s*([^\s#]+)/m);
      if (userMatch?.[1]) return userMatch[1].trim().slice(0, 40);
    } catch {
      // Ignore unreadable gh config.
    }
  }
  return "";
}

export function detectAuthorName(workingDirectory) {
  const envAuthor = (process.env.COPILOT_EVO_AUTHOR || "").trim();
  if (envAuthor) return envAuthor.slice(0, 40);
  const ghUser = detectGhLogin();
  if (ghUser) return ghUser;
  const tryGitUser = (args) => {
    try {
      return execFileSync("git", args, {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  const name =
    (workingDirectory && fs.existsSync(workingDirectory)
      ? tryGitUser(["-C", workingDirectory, "config", "--get", "user.name"])
      : "") || tryGitUser(["config", "--global", "--get", "user.name"]);
  if (!name || /@/.test(name)) return "";
  return name.slice(0, 40);
}

export function hashProjectId(workingDirectory) {
  return detectSourceLabel(workingDirectory);
}

const SIGNAL_PATTERNS = [
  ["test_failure", /\b(?:test|jest|vitest|pytest|mocha|node --test|assert|failing|failed)\b/i],
  ["build_error", /\b(?:build|compile|tsc|webpack|vite|esbuild|bundle)\b/i],
  ["lint_error", /\b(?:lint|eslint|prettier|ruff|flake8)\b/i],
  ["enoent", /\b(?:ENOENT|no such file|cannot find module|not found)\b/i],
  ["permission_denied", /\b(?:EACCES|EPERM|permission denied|unauthorized|401|403)\b/i],
  ["network_error", /\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network|timeout)\b/i],
  ["git_error", /\b(?:git|merge conflict|detached HEAD|rebase|push rejected)\b/i],
  ["npm_error", /\b(?:npm|pnpm|yarn|ERR!|E401|ERESOLVE)\b/i],
  ["python_error", /\b(?:python|pip|pytest|Traceback|ModuleNotFoundError)\b/i],
  ["powershell_error", /\b(?:powershell|pwsh|ExecutionPolicy|here-string|<<EOF)\b/i],
  ["win32", /\b(?:windows|win32|powershell|pwsh|cmd\.exe|\.bat|\.cmd|backslash)\b|\\\\/i],
  ["syntax_error", /\b(?:SyntaxError|Unexpected token|ParseError)\b/i],
  ["type_error", /\b(?:TypeError|ReferenceError|TS\d{4})\b/i],
  ["share", /\b(?:share|sync|export|publish|team|push)\b/i],
  ["secret_leak", /\b(?:secret|token|password|api[_-]?key|redact|privacy)\b/i],
  ["pull_request", /\b(?:pull\s+request|create\s+(?:a\s+)?pr|draft\s+(?:a\s+)?pr|open\s+(?:a\s+)?pr|gh\s+pr\s+(?:create|edit)|pr\s+description|pr\s+body|pr\s+summary)\b|(?:draft|create|open|提|创建|发|改).*?\bpr\b|拉取请求/i],
  ["pr_description", /\b(?:pr\s+description|pr\s+body|pr\s+summary|pull\s+request\s+description)\b/i],
  ["documentation", /\b(?:docs?|documentation|readme|markdown|changelog)\b|\.(?:md|mdx)\b/i],
  ["markdown", /\bmarkdown\b|\.(?:md|mdx)\b/i],
  ["pr_review", /\b(?:pr\s*#?\d+|pull\s+request|code[\s-]?review|review\s+(?:this|the|a)?\s*(?:pr|diff|changes|branch|code)|reviewing\s+pr)\b|审查\s*PR|代码审查/i],
];

const STRATEGY_CUE_RE = /(?:记住|以后|下次|踩坑|经验|策略|规范|沉淀|固化|避免|总是|不要再|应该|记得|\b(?:always|never|remember|pitfall|workaround|lesson|best practice|convention|we should|make sure to|don't forget to)\b)/i;
const NEGATIVE_FEEDBACK_RE = /(?:不对|没用|无效|还是报错|不行|别这么做|错了|过时|\b(?:wrong|didn't work|did not work|doesn't work|still failing|not helpful|outdated|stop doing)\b)/i;
const CORRECTION_OR_PITFALL_RE = /(?:不对|没用|无效|还是报错|不行|别这么做|错了|过时|看不到|没显示|显示不出来|不生效|没生效|漏了|打不开|\b(?:wrong|didn't work|did not work|doesn't work|not working|still failing|can\s*not\s+show|cannot\s+show|doesn't\s+show|not\s+showing|didn't\s+render|not\s+rendered|not\s+clickable|doesn't\s+link|broken|missing)\b)/i;

const TRIVIAL_TOOL_FAILURE_RE = {
  create: /(?:already exists|parent directory .* does not exist|does not exist)/i,
  edit: /(?:old_str not found|multiple matches found|does not exist|no match found)/i,
  view: /(?:does not exist|no such file|not found|is a directory)/i,
  extensions_manage: /(?:not found|unknown extension)/i,
};

export function isTrivialToolFailure(toolName, errorText) {
  const re = TRIVIAL_TOOL_FAILURE_RE[String(toolName || "").toLowerCase()];
  if (!re) return false;
  return re.test(String(errorText || ""));
}

export function hasStrategyCue(text) {
  return typeof text === "string" && STRATEGY_CUE_RE.test(text);
}

export function hasNegativeFeedbackCue(text) {
  return typeof text === "string" && NEGATIVE_FEEDBACK_RE.test(text);
}

export function hasCorrectionOrPitfallCue(text) {
  return typeof text === "string" && CORRECTION_OR_PITFALL_RE.test(text);
}

const PR_REVIEW_RE = /\b(?:pr\s*#?\d+|pull\s+request|code[\s-]?review|pr\s+review|review\s+(?:this|the|a|my)?\s*(?:pr|diff|changes|branch|code)|check\s+(?:this|the)?\s*pr|reviewing\s+pr)\b|审查\s*PR|代码审查|review\s*一下/i;

export function isPrReviewCue(text) {
  return typeof text === "string" && PR_REVIEW_RE.test(text);
}

export function extractToolTargetKey(toolName, toolArgs) {
  const tool = String(toolName || "").trim();
  if (!tool || tool.startsWith("evo_")) return "";
  if (/^(?:view|glob|grep|list_|get_|read_|tool_search_tool|ask_user|open_canvas|navigate_)/i.test(tool)) {
    return "";
  }
  let args = toolArgs;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = { raw: args };
    }
  }
  if (!args || typeof args !== "object") return "";
  if (typeof args.path === "string" && args.path) {
    return `file:${path.normalize(args.path).toLowerCase()}`;
  }
  if (args.thread_id) return `pr_thread:${args.thread_id}`;
  if (args.root_comment_id) return `pr_comment:${args.root_comment_id}`;
  const cmd = String(args.command || args.cmd || args.raw || "");
  if (cmd) {
    const ghPrEditMatch = cmd.match(/\bgh\s+pr\s+edit(?:\s+(\d+))?/i);
    if (ghPrEditMatch) return ghPrEditMatch[1] ? `gh_pr_edit:${ghPrEditMatch[1]}` : "gh_pr_edit";
    const ghCommentMatch = cmd.match(/(?:pulls\/comments\/|issues\/comments\/|gh\s+pr\s+comment[^\r\n]*?)(\d+)/i);
    if (ghCommentMatch) return `gh_comment:${ghCommentMatch[1]}`;
    if (/\bgh\s+api\b.*\bPATCH\b/i.test(cmd)) return "gh_api_patch";
  }
  return "";
}

const READ_ONLY_SHELL_RE = /^\s*(?:git\s+(?:status|log|diff|show|branch|rev-parse|remote|config\s+--get)|gh\s+(?:pr|issue|run|repo)\s+(?:view|diff|list|status|checks)|Get-Content|Get-ChildItem|Select-String|Test-Path|cat|ls|rg|head|tail)\b/i;

export function isActionToolName(toolName, toolArgs) {
  const tool = String(toolName || "").trim();
  if (!tool || tool.startsWith("evo_")) return false;
  if (/^(?:view|glob|grep|list_|get_|read_|tool_search_tool|ask_user|open_canvas|navigate_|skill|rename_session|store_memory|vote_memory|extensions_list|github-mcp-server-get_|github-mcp-server-list_|github-mcp-server-search_)/i.test(tool)) {
    return false;
  }
  if (/^(?:powershell|bash|shell)$/i.test(tool)) {
    let cmd = "";
    if (typeof toolArgs === "string") {
      try {
        const parsed = JSON.parse(toolArgs);
        cmd = String(parsed?.command || parsed?.cmd || toolArgs);
      } catch {
        cmd = toolArgs;
      }
    } else if (toolArgs && typeof toolArgs === "object") {
      cmd = String(toolArgs.command || toolArgs.cmd || "");
    }
    const clean = cmd.trim();
    if (clean && READ_ONLY_SHELL_RE.test(clean) && !/[|;&><`]|\$\(/.test(clean)) {
      return false;
    }
  }
  return true;
}

export function shouldNudgePostToolUse(state) {
  if (!state || !state.turnIndex) return false;
  if (state.lastNudgeTurn === state.turnIndex) return false;
  if (state.solidifiedTurn === state.turnIndex) return false;
  return (state.turnActionTools || 0) >= 1;
}

export function isFollowUpEditTrajectory({
  turnIndex = 0,
  priorActionTurns = 0,
  prompt = "",
  targetKey = "",
  priorActionTargets = null,
} = {}) {
  if (turnIndex <= 1 || priorActionTurns < 1) return false;
  const trimmed = String(prompt || "").trim();
  if (!trimmed || trimmed.length > 220) return false;
  if (targetKey && priorActionTargets instanceof Set && priorActionTargets.has(targetKey)) {
    return true;
  }
  // A short follow-up prompt after a prior completed edit turn that triggers a new edit
  // signals a potential missed requirement or companion-file update.
  return Boolean(targetKey) || trimmed.length <= 140;
}

export function shouldReflectOnAgentStop(state, stopHookActive = false) {
  if (stopHookActive) return false;
  if (!state || !state.turnIndex) return false;
  if (state.solidifiedTurn === state.turnIndex) return false;
  if (state.lastStopReflectionTurn === state.turnIndex) return false;
  if ((state.turnActionTools || 0) < 1) return false;
  return Boolean(
    state.turnHadRecovery ||
      state.turnHadCorrection ||
      state.turnHadStrategyCue ||
      state.turnHadFollowUpEdit
  );
}

export function extractSignals(text, extraSignals = [], options = {}) {
  const signals = new Set(extraSignals.map((s) => String(s).toLowerCase()).filter(Boolean));
  if (options.includePlatform && process.platform === "win32") {
    signals.add("win32");
  }
  if (typeof text === "string" && text.trim()) {
    for (const [tag, regex] of SIGNAL_PATTERNS) {
      if (regex.test(text)) signals.add(tag);
    }
  }
  return Array.from(signals);
}

function normalizeAssetKind(raw) {
  return normalizeExperienceType(raw);
}

const SEARCH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "have",
  "should", "what", "when", "where", "which", "about", "there", "their", "then",
  "than", "also", "just", "only", "some", "make", "need", "does", "not", "are",
  "was", "were", "can", "will", "how", "why",
]);

const SYNONYM_GROUPS = [
  ["pr", "pull", "pull_request", "merge_request"],
  ["description", "summary", "body", "overview"],
  ["doc", "docs", "documentation", "readme", "markdown"],
  ["test", "tests", "testing", "spec", "unit", "vitest", "pytest", "jest"],
  ["deploy", "deployment", "redeploy", "release", "publish", "pipeline"],
  ["bump", "version", "changelog", "tag"],
  ["review", "audit", "check", "lint"],
  ["error", "fail", "failure", "crash", "bug", "exception", "broken"],
  ["fix", "patch", "resolve", "workaround", "solution"],
  ["comment", "reply", "thread", "sha", "commit"],
  ["config", "settings", "env", "environment"],
];

const SYNONYM_MAP = (() => {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      if (!map.has(word)) map.set(word, new Set());
      for (const peer of group) {
        if (peer !== word) map.get(word).add(peer);
      }
    }
  }
  return map;
})();

function tokenizeForSearch(text) {
  const raw = String(text || "").toLowerCase();
  const matches = raw.match(/[a-z0-9_]+/g) || [];
  const tokens = [];
  for (const tok of matches) {
    if (tok.length >= 2 && !SEARCH_STOP_WORDS.has(tok)) {
      tokens.push(tok);
    }
    if (tok.includes("_")) {
      for (const part of tok.split("_")) {
        if (part.length >= 2 && !SEARCH_STOP_WORDS.has(part)) {
          tokens.push(part);
        }
      }
    }
  }
  return tokens;
}

function expandQueryTerms(query) {
  const rawLower = String(query || "").toLowerCase();
  const baseTokens = tokenizeForSearch(rawLower);
  const weights = new Map();
  for (const tok of baseTokens) {
    weights.set(tok, 1.0);
    const peers = SYNONYM_MAP.get(tok);
    if (peers) {
      for (const peer of peers) {
        if (!weights.has(peer)) weights.set(peer, 0.55);
      }
    }
  }
  return { rawTerms: rawLower.split(/\s+/).filter((t) => t.length >= 2), weights };
}

function globToRegExp(pattern) {
  const normalized = String(pattern || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized) return null;
  let regexStr = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        regexStr += ".*";
        i++;
        if (normalized[i + 1] === "/") i++;
      } else {
        regexStr += "[^/]*";
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, "i");
}

export function extractPathsFromText(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const matches = text.match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_-]+)?/g) || [];
  return Array.from(
    new Set(
      matches
        .map((m) => m.replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((m) => !/^https?:\/\//i.test(m))
    )
  );
}

function matchesAnyPathPattern(pathPatterns, activePaths) {
  if (!Array.isArray(pathPatterns) || !pathPatterns.length) return null;
  if (!Array.isArray(activePaths) || !activePaths.length) return null;
  for (const rawPat of pathPatterns) {
    const re = globToRegExp(rawPat);
    if (!re) continue;
    for (const rawPath of activePaths) {
      const cleanPath = String(rawPath || "").replace(/\\/g, "/").replace(/^file:/i, "").replace(/^\.\//, "");
      const relMatch = cleanPath.replace(/^[A-Za-z]:\/[^/]+\/[^/]+\//, "");
      if (re.test(cleanPath) || re.test(relMatch)) return true;
    }
  }
  return false;
}

export function selectAssets({
  signals = [],
  query = "",
  scope = "",
  kind = "",
  repo = "",
  activePaths = [],
  excludeIds = [],
  isReview = false,
  isFailure = false,
  isSearch = false,
  includeSuperseded = false,
  includeGraduated = false,
  rules = [],
  fixes = [],
  knowledge = [],
  limit = 3,
}) {
  const sigSet = new Set(signals.map((s) => String(s).toLowerCase()));
  const excludeSet = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const { rawTerms, weights: queryWeights } = expandQueryTerms(query);
  const all = [...rules, ...fixes, ...knowledge];
  const supersededIds = new Set(all.map((a) => a.supersedes).filter(Boolean));
  const normalizedRepo = repo && repo !== "*" ? normalizeRepoSlug(repo) : "";
  const normalizedKind = kind ? normalizeAssetKind(kind) : "";
  const reviewContext = Boolean(isReview || sigSet.has("pr_review"));
  const nowMs = Date.now();

  const docTokenMap = new Map();
  const docFreq = new Map();
  let totalLen = 0;
  for (const asset of all) {
    const assetSignals = (asset.signals || []).map((s) => String(s).toLowerCase());
    const text = [
      asset.id || "",
      asset.title || "",
      asset.title || "",
      asset.summary || "",
      asset.solution || "",
      ...(Array.isArray(asset.strategy) ? asset.strategy : []),
      ...assetSignals,
    ].join(" ");
    const tokens = tokenizeForSearch(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    docTokenMap.set(asset.id, { tf, len: tokens.length || 1 });
    totalLen += tokens.length || 1;
    for (const uniq of tf.keys()) {
      docFreq.set(uniq, (docFreq.get(uniq) || 0) + 1);
    }
  }
  const avgDocLen = all.length ? totalLen / all.length : 1;
  const corpusSize = Math.max(1, all.length);
  const k1 = 1.2;
  const b = 0.75;

  const scored = [];
  for (const asset of all) {
    const assetType = normalizeExperienceType(asset.type);
    if (scope && asset.scope !== scope) continue;
    if (normalizedKind && assetType !== normalizedKind) continue;
    if (!isSearch && excludeSet.has(asset.id)) continue;
    if (!includeSuperseded && supersededIds.has(asset.id) && !rawTerms.includes(asset.id.toLowerCase())) continue;
    // Mute only when downvoted/failing or recalled extensively with zero helpfulness.
    if (
      !isSearch &&
      !isFailure &&
      !asset.pinned &&
      ((Number(asset.failureCount || 0) > 0 && Number(asset.failureCount || 0) >= Number(asset.successCount || 0)) ||
        (Number(asset.recallCount || 0) >= 25 && Number(asset.successCount || 0) === 0))
    ) {
      continue;
    }

    const assetRepo = normalizeRepoSlug(asset.repoScope || "*");
    if (assetRepo !== "*" && normalizedRepo && assetRepo.toLowerCase() !== normalizedRepo.toLowerCase()) continue;
    if (assetRepo !== "*" && !normalizedRepo && !rawTerms.length && sigSet.size > 0) continue;
    if (
      !includeGraduated &&
      normalizedRepo &&
      asset.graduatedTo?.targetPath &&
      normalizeRepoSlug(asset.graduatedTo.repo || assetRepo).toLowerCase() === normalizedRepo.toLowerCase() &&
      !rawTerms.includes(asset.id.toLowerCase())
    ) {
      continue;
    }

    const pathMatch = matchesAnyPathPattern(asset.pathPatterns, activePaths);
    if (pathMatch === false && !isSearch) continue;

    let relevance = 0;
    const assetSignals = (asset.signals || []).map((s) => String(s).toLowerCase());
    for (const sig of assetSignals) {
      if (sigSet.has(sig)) relevance += 3;
    }

    const docInfo = docTokenMap.get(asset.id);
    if (docInfo && queryWeights.size > 0) {
      let bm25 = 0;
      for (const [term, weight] of queryWeights.entries()) {
        const tf = docInfo.tf.get(term) || 0;
        if (!tf) continue;
        const df = docFreq.get(term) || 0;
        const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5));
        const denom = tf + k1 * (1 - b + b * (docInfo.len / avgDocLen));
        bm25 += weight * idf * ((tf * (k1 + 1)) / denom);
      }
      relevance += bm25 * 2.2;
    }

    if (rawTerms.includes(String(asset.id || "").toLowerCase())) {
      relevance += 4;
    }
    if (reviewContext && normalizedRepo && assetRepo.toLowerCase() === normalizedRepo.toLowerCase()) {
      relevance = Math.max(relevance, 2);
    }
    if (sigSet.size === 0 && rawTerms.length === 0) {
      relevance = 1;
    }
    if (relevance > 0) {
      const repoBoost = assetRepo !== "*" && normalizedRepo && assetRepo.toLowerCase() === normalizedRepo.toLowerCase() ? 1.5 : 0;
      const pathBoost = pathMatch === true ? 2.5 : 0;
      const contextBoost =
        (isFailure && (assetType === "Fix" || assetType === "Knowledge") ? 0.75 : 0) +
        (reviewContext && (assetType === "Rule" || assetType === "Knowledge") ? 0.75 : 0);
      const gdiScore = computeGdiScore(asset, all, nowMs);
      scored.push({ asset, score: relevance + repoBoost + pathBoost + contextBoost + gdiScore * 0.05, gdiScore });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => item.asset);
}

function slugify(text, maxLen = 48) {
  return String(text || "asset")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen) || "asset";
}

const CJK_SCRIPT_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function hasNonEnglishText(asset) {
  const fields = [
    asset.title,
    asset.summary,
    asset.solution,
    ...(asset.signals || []),
    ...(asset.strategy || []),
  ];
  return fields.some((item) => typeof item === "string" && CJK_SCRIPT_RE.test(item));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "when", "that", "this", "into", "from", "use", "using",
  "all", "not", "only", "across", "before", "after", "unless", "keep", "avoid", "always", "never",
]);

function tokenizeForSimilarity(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map((w) => {
      if (w.length >= 6 && w.endsWith("ing")) return w.slice(0, -3);
      if (w.length >= 5 && w.endsWith("ed")) return w.slice(0, -2);
      if (w.length >= 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
      return w;
    });
  return new Set(words);
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function findSimilarAssets(candidate, existingAssets = [], options = {}) {
  const threshold = options.threshold ?? 0.46;
  const candType = normalizeAssetKind(candidate?.type || candidate?.kind);
  const candRepo = normalizeRepoSlug(candidate?.repoScope || "*");
  const candTitleTokens = tokenizeForSimilarity(candidate?.title || "");
  const candTextTokens = tokenizeForSimilarity(`${candidate?.title || ""} ${candidate?.summary || ""}`);
  const candSignals = new Set((candidate?.signals || []).map((s) => String(s).toLowerCase()).filter(Boolean));
  const supersededIds = new Set(existingAssets.map((a) => a.supersedes).filter(Boolean));

  const matches = [];
  for (const existing of existingAssets) {
    if (!existing?.id || existing.id === candidate?.id) continue;
    if (supersededIds.has(existing.id)) continue;
    if (normalizeAssetKind(existing.type) !== candType) continue;
    const exRepo = normalizeRepoSlug(existing.repoScope || "*");
    if (candRepo !== "*" && exRepo !== "*" && candRepo.toLowerCase() !== exRepo.toLowerCase()) continue;

    const exTitleTokens = tokenizeForSimilarity(existing.title || "");
    const exTextTokens = tokenizeForSimilarity(`${existing.title || ""} ${existing.summary || ""}`);
    const exSignals = new Set((existing.signals || []).map((s) => String(s).toLowerCase()).filter(Boolean));

    const titleSim = jaccardSimilarity(candTitleTokens, exTitleTokens);
    const textSim = jaccardSimilarity(candTextTokens, exTextTokens);
    const sigSim = jaccardSimilarity(candSignals, exSignals);
    const score = titleSim * 0.45 + textSim * 0.3 + sigSim * 0.25;

    if (score >= threshold || (titleSim >= 0.45 && sigSim >= 0.5)) {
      matches.push({
        id: existing.id,
        title: existing.title,
        scope: existing.scope || "local",
        repoScope: existing.repoScope || "*",
        similarity: Math.round(score * 100) / 100,
        preview: formatAssetPreview(existing),
      });
    }
  }
  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, options.limit || 2);
}

export function solidifyAsset(input, options = {}) {
  const evoHome = initStore(options);
  const kind = normalizeAssetKind(input.kind);
  const scope = input.scope === "team" ? "team" : "local";
  const id = input.id ? slugify(input.id, 96) : `exp-${slugify(input.title)}-${Date.now().toString(36)}`;

  const validation = Array.isArray(input.validation) ? input.validation.filter(Boolean) : [];
  for (const cmd of validation) {
    if (!isValidationCommandAllowed(cmd)) {
      return {
        ok: false,
        error: `Validation command rejected by safety policy: ${cmd}. Only safe node/npm/npx/pytest/dotnet/cargo/go test commands without shell operators are allowed.`,
      };
    }
  }

  const rawReferences = Array.isArray(input.references) ? input.references.filter(Boolean) : [];
  const references = [];
  for (const rawRef of rawReferences) {
    const normalized = normalizeEvidenceLink(rawRef);
    if (!normalized) {
      return {
        ok: false,
        error: "Reference link rejected: only public https:// URLs without credentials or private/local hosts are allowed.",
      };
    }
    if (!references.some((r) => r.url === normalized.url)) {
      references.push(normalized);
    }
  }

  const resolvedRepoScope =
    input.repoScope === "current"
      ? detectRepoSlug(input.workingDirectory) || "*"
      : normalizeRepoSlug(input.repoScope || "*");

  const author = (input.author || detectAuthorName(input.workingDirectory) || "").trim();

  const pathPatterns = Array.isArray(input.pathPatterns)
    ? input.pathPatterns
        .map((p) => String(p || "").trim().replace(/\\/g, "/"))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  const rawAsset = {
    id,
    type: kind,
    title: input.title,
    summary: input.summary,
    signals: Array.isArray(input.signals) ? input.signals.map((s) => String(s).toLowerCase()) : [],
    strategy: Array.isArray(input.strategy) ? input.strategy : [],
    solution: input.solution || "",
    validation,
    ...(references.length ? { references } : {}),
    ...(pathPatterns.length ? { pathPatterns } : {}),
    scope,
    repoScope: resolvedRepoScope,
    ...(input.ruleId ? { ruleId: slugify(input.ruleId) } : {}),
    ...(input.parentId ? { parentId: slugify(input.parentId) } : {}),
    ...(input.supersedes ? { supersedes: slugify(input.supersedes) } : {}),
    sourceProject: detectSourceLabel(input.workingDirectory),
    ...(author ? { author } : {}),
    updatedAt: new Date().toISOString(),
  };

  if (hasNonEnglishText(rawAsset)) {
    return {
      ok: false,
      error: "All solidified Experiences (Knowledge, Rule, Fix) must be written in English. Translate title, summary, signals, strategy, and solution into English and retry evo_solidify.",
    };
  }

  const leakCheck = fullLeakCheck(rawAsset);
  if (scope === "team" && leakCheck.found) {
    return {
      ok: false,
      error: "Team experience rejected: sensitive pattern or environment secret detected. Replace secrets/paths with placeholders before solidifying as team scope.",
      leaks: leakCheck.leaks,
    };
  }

  const cleanAsset = sanitizePayload(rawAsset);
  const allStoreFiles = ["rules.json", "fixes.json", "knowledge.json"];
  const targetFileName = getFileNameForType(kind);
  const targetFile = path.join(evoHome, targetFileName);
  const list = readJsonSafe(targetFile, []);
  const idx = list.findIndex((item) => item.id === cleanAsset.id);

  // Check if this ID currently lives under another category (reclassification in place).
  let prevExisting = idx >= 0 ? list[idx] : null;
  let movedFromFile = "";
  if (!prevExisting) {
    for (const fileName of allStoreFiles) {
      if (fileName === targetFileName) continue;
      const otherPath = path.join(evoHome, fileName);
      const otherList = readJsonSafe(otherPath, []);
      const otherIdx = otherList.findIndex((item) => item.id === cleanAsset.id);
      if (otherIdx >= 0) {
        prevExisting = otherList[otherIdx];
        movedFromFile = otherPath;
        break;
      }
    }
  }

  if (!prevExisting && !input.allowDuplicate && !input.supersedes) {
    const store = loadStore(evoHome);
    const similarCandidates = findSimilarAssets(cleanAsset, [
      ...store.rules,
      ...store.fixes,
      ...store.knowledge,
    ]);
    if (similarCandidates.length) {
      const top = similarCandidates[0];
      return {
        ok: false,
        duplicateDetected: true,
        similarCandidates,
        error: `Similar experience already exists: "${top.id}" (${top.title}, ${Math.round(top.similarity * 100)}% similar). Update it in place by passing its id, replace it via supersedes: "${top.id}", or pass allowDuplicate: true only if genuinely distinct.`,
      };
    }
  }

  if (prevExisting) {
    cleanAsset.successCount = prevExisting.successCount ?? 1;
    if (prevExisting.pendingSuccessDelta) cleanAsset.pendingSuccessDelta = prevExisting.pendingSuccessDelta;
    if (prevExisting.recallCount) cleanAsset.recallCount = prevExisting.recallCount;
    if (prevExisting.pendingRecallDelta) cleanAsset.pendingRecallDelta = prevExisting.pendingRecallDelta;
    if (prevExisting.failureCount) cleanAsset.failureCount = prevExisting.failureCount;
    if (prevExisting.pendingFailureDelta) cleanAsset.pendingFailureDelta = prevExisting.pendingFailureDelta;
    if (prevExisting.pinned) cleanAsset.pinned = true;
    if (prevExisting.priority) cleanAsset.priority = prevExisting.priority;
    if (prevExisting.author && !input.author) cleanAsset.author = prevExisting.author;
    if (prevExisting.sourceProject && !prevExisting.sourceProject.startsWith("proj-")) {
      cleanAsset.sourceProject = prevExisting.sourceProject;
    }
    if (idx >= 0) {
      list[idx] = { ...prevExisting, ...cleanAsset };
    } else {
      list.push({ ...prevExisting, ...cleanAsset });
    }
  } else {
    cleanAsset.successCount = 1;
    if (scope === "team") cleanAsset.pendingSuccessDelta = 1;
    list.push(cleanAsset);
  }
  writeJson(targetFile, list);
  if (movedFromFile) {
    const oldList = readJsonSafe(movedFromFile, []).filter((item) => item.id !== cleanAsset.id);
    writeJson(movedFromFile, oldList);
  }

  if (cleanAsset.ruleId || cleanAsset.parentId) {
    recordAssetOutcome(
      evoHome,
      [cleanAsset.ruleId, cleanAsset.parentId].filter(Boolean),
      "success",
      "derived_experience"
    );
  }

  appendEvent(evoHome, {
    event: "solidify",
    assetId: cleanAsset.id,
    assetType: kind,
    scope,
    signals: cleanAsset.signals,
    redactedOnLocalSave: leakCheck.found,
  });

  return {
    ok: true,
    asset: cleanAsset,
    preview: formatAssetPreview(cleanAsset),
    redacted: leakCheck.found,
    nextAction:
      scope === "team"
        ? "Show the full English preview to the user and ask whether to push via evo_sync_repo(action: 'push')."
        : "Saved locally. Show the full English preview to the user and ask whether to keep it local or promote to team (evo_manage_asset promote_team) and push (evo_sync_repo push).",
  };
}

export function manageAsset(action, id, options = {}) {
  const evoHome = initStore(options);
  const rulesPath = path.join(evoHome, "rules.json");
  const fixesPath = path.join(evoHome, "fixes.json");
  const knowledgePath = path.join(evoHome, "knowledge.json");

  const rules = readJsonSafe(rulesPath, []);
  const fixes = readJsonSafe(fixesPath, []);
  const knowledge = readJsonSafe(knowledgePath, []);

  const findTarget = () => {
    for (const [list, filePath] of [
      [rules, rulesPath],
      [fixes, fixesPath],
      [knowledge, knowledgePath],
    ]) {
      const idx = list.findIndex((a) => a.id === id);
      if (idx >= 0) return { list, filePath, idx };
    }
    return null;
  };

  if (action === "inspect") {
    const allAssets = [...rules, ...fixes, ...knowledge];
    const found = allAssets.find((a) => a.id === id);
    if (!found) return { ok: false, error: `Experience not found: ${id}` };
    return {
      ok: true,
      asset: found,
      gdiScore: computeGdiScore(found, allAssets),
      relationships: getAssetRelationships(found, allAssets),
    };
  }

  if (action === "pin" || action === "unpin" || action === "upvote" || action === "downvote") {
    const target = findTarget();
    if (!target) return { ok: false, error: `Experience not found: ${id}` };
    const current = { ...target.list[target.idx] };
    if (action === "pin") current.pinned = true;
    if (action === "unpin") current.pinned = false;
    if (action === "upvote") {
      current.successCount = (current.successCount || 0) + 1;
      current.pendingSuccessDelta = (current.pendingSuccessDelta || 0) + 1;
    }
    if (action === "downvote") {
      current.failureCount = (current.failureCount || 0) + 1;
      current.pendingFailureDelta = (current.pendingFailureDelta || 0) + 1;
    }
    current.updatedAt = new Date().toISOString();
    target.list[target.idx] = current;
    writeJson(target.filePath, target.list);
    appendEvent(evoHome, { event: `feedback_${action}`, assetId: current.id, assetType: current.type });
    return { ok: true, asset: current, gdiScore: computeGdiScore(current, [...rules, ...fixes, ...knowledge]) };
  }

  if (action === "promote_team") {
    const target = findTarget();
    if (!target) return { ok: false, error: `Experience not found: ${id}` };
    const candidate = { ...target.list[target.idx], scope: "team", updatedAt: new Date().toISOString() };
    const leaks = fullLeakCheck(candidate);
    if (leaks.found) {
      const details = leaks.leaks.map((l) => `${l.type}${l.envKey ? `(${l.envKey})` : ""}`).join(", ");
      return {
        ok: false,
        error: `Cannot promote to team: sensitive pattern detected (${details}).`,
        leaks: leaks.leaks,
      };
    }
    const clean = sanitizePayload(candidate);
    target.list[target.idx] = clean;
    writeJson(target.filePath, target.list);
    const curDeleted = loadStore(evoHome).config.deletedTeamIds || [];
    if (curDeleted.includes(clean.id)) {
      saveConfig(evoHome, { deletedTeamIds: curDeleted.filter((x) => x !== clean.id) });
    }
    appendEvent(evoHome, { event: "promote_team", assetId: clean.id, assetType: clean.type });
    return { ok: true, asset: clean };
  }

  if (action === "delete") {
    const existingItem = [...rules, ...fixes, ...knowledge].find((a) => a.id === id);
    if (!existingItem) return { ok: false, error: `Experience not found: ${id}` };
    const nextRules = rules.filter((a) => a.id !== id);
    const nextFixes = fixes.filter((a) => a.id !== id);
    const nextKnowledge = knowledge.filter((a) => a.id !== id);
    if (nextRules.length !== rules.length) writeJson(rulesPath, nextRules);
    if (nextFixes.length !== fixes.length) writeJson(fixesPath, nextFixes);
    if (nextKnowledge.length !== knowledge.length) writeJson(knowledgePath, nextKnowledge);
    const wasTeam = existingItem.scope === "team";
    if (wasTeam) {
      const curDeleted = loadStore(evoHome).config.deletedTeamIds || [];
      if (!curDeleted.includes(id)) {
        saveConfig(evoHome, { deletedTeamIds: [...curDeleted, id] });
      }
    }
    appendEvent(evoHome, { event: "delete", assetId: id, assetType: existingItem.type, scope: existingItem.scope });
    return {
      ok: true,
      deletedId: id,
      wasTeam,
      nextAction: wasTeam
        ? "Deleted team experience locally. Push via evo_sync_repo({ action: 'push' }) after user confirmation to remove it from the shared team repository."
        : "Deleted local experience.",
    };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}

export function exportBundle(evoHome, { scope = "team", outputPath }) {
  const { rules, fixes, knowledge } = loadStore(evoHome);
  const filterFn = (item) => (scope === "all" ? item.scope !== "starter" : item.scope === scope);
  const selectedRules = rules.filter(filterFn).map((r) => sanitizePayload(stripLocalSyncFields(r)));
  const selectedFixes = fixes.filter(filterFn).map((f) => sanitizePayload(stripLocalSyncFields(f)));
  const selectedKnowledge = knowledge.filter(filterFn).map((k) => sanitizePayload(stripLocalSyncFields(k)));

  const bundle = {
    schema: "copilot-evo/bundle@1",
    exportedAt: new Date().toISOString(),
    rules: selectedRules,
    fixes: selectedFixes,
    knowledge: selectedKnowledge,
  };
  const leaks = fullLeakCheck(bundle);
  if (leaks.found) {
    return { ok: false, error: "Export aborted: sensitive content detected.", leaks: leaks.leaks };
  }
  if (outputPath) {
    writeJson(outputPath, bundle);
  }
  return { ok: true, bundle, outputPath };
}

export function importBundle(evoHome, { inputPath, bundleData, respectDeletedTeamIds = false } = {}) {
  const bundle = bundleData || readJsonSafe(inputPath, null);
  if (!bundle || (!Array.isArray(bundle.rules) && !Array.isArray(bundle.fixes) && !Array.isArray(bundle.knowledge))) {
    return { ok: false, error: "Invalid experience bundle." };
  }
  const deletedSet = respectDeletedTeamIds
    ? new Set(loadStore(evoHome).config.deletedTeamIds || [])
    : new Set();
  const incoming = [
    ...(bundle.rules || []).map((r) => sanitizePayload({ ...r, type: "Rule" })),
    ...(bundle.fixes || []).map((f) => sanitizePayload({ ...f, type: "Fix" })),
    ...(bundle.knowledge || []).map((k) => sanitizePayload({ ...k, type: "Knowledge" })),
  ].filter((item) => !deletedSet.has(item.id));

  const valid = [];
  const rejected = [];
  for (const item of incoming) {
    const badCmd = (item.validation || []).find((cmd) => !isValidationCommandAllowed(cmd));
    if (badCmd) {
      rejected.push({ id: item.id, reason: `Unsafe validation command: ${badCmd}` });
      continue;
    }
    valid.push(item);
  }

  const incomingTypeById = new Map(valid.map((a) => [a.id, a.type]));
  const pruneMoved = (list, expectedType) =>
    list.filter((item) => !incomingTypeById.has(item.id) || incomingTypeById.get(item.id) === expectedType);

  const rulesPath = path.join(evoHome, "rules.json");
  const fixesPath = path.join(evoHome, "fixes.json");
  const knowledgePath = path.join(evoHome, "knowledge.json");
  const rRes = mergeById(pruneMoved(readJsonSafe(rulesPath, []), "Rule"), valid.filter((a) => a.type === "Rule"), {
    updateExisting: true,
  });
  const fRes = mergeById(pruneMoved(readJsonSafe(fixesPath, []), "Fix"), valid.filter((a) => a.type === "Fix"), {
    updateExisting: true,
  });
  const kRes = mergeById(
    pruneMoved(readJsonSafe(knowledgePath, []), "Knowledge"),
    valid.filter((a) => a.type === "Knowledge"),
    { updateExisting: true }
  );
  writeJson(rulesPath, rRes.merged);
  writeJson(fixesPath, fRes.merged);
  writeJson(knowledgePath, kRes.merged);
  return {
    ok: true,
    imported: rRes.added + fRes.added + kRes.added,
    updated: rRes.updated + fRes.updated + kRes.updated,
    rejected,
  };
}

function runCmd(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

function runGit(repoPath, args) {
  return runCmd("git", ["-C", repoPath, ...args]);
}

function slugToDirName(slugOrUrl) {
  return String(slugOrUrl || "team-repo")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "--")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "team-repo";
}

function isRemoteGitUrl(str) {
  return /^(?:https?:\/\/|git@|file:\/\/)/i.test(String(str || "").trim());
}

function parseRepoTarget(raw) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const ghUrlMatch = trimmed.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/i
  );
  if (ghUrlMatch) {
    const slug = ghUrlMatch[1];
    return { target: slug, cloneUrl: `https://github.com/${slug}.git`, slug, isSlug: true };
  }
  if (isRemoteGitUrl(trimmed) || fs.existsSync(trimmed)) {
    const slug = isRemoteGitUrl(trimmed) ? normalizeRepoSlug(trimmed) : "";
    return { target: trimmed, cloneUrl: trimmed, slug: slug !== "*" ? slug : "", isSlug: false };
  }
  const slug = normalizeRepoSlug(trimmed);
  if (!slug || slug === "*") return null;
  return { target: slug, cloneUrl: `https://github.com/${slug}.git`, slug, isSlug: true };
}

async function hasGitHead(repoPath) {
  try {
    await runGit(repoPath, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export function resolveSyncRepoPath(evoHome, explicitPath) {
  const config = loadStore(evoHome).config;
  const repoCloneDir = config.syncRepo
    ? path.join(evoHome, "sync-repos", slugToDirName(config.syncRepo))
    : "";
  const legacyDir = config.syncRepo ? path.join(evoHome, "sync-repo") : "";
  const candidates = [
    explicitPath,
    config.syncRepoPath,
    process.env.COPILOT_EVO_SYNC_REPO,
    repoCloneDir,
    legacyDir,
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
  }
  return null;
}

// Clones the configured private team data repo if not cloned locally yet.
async function ensureSyncRepo(evoHome, { repoPath, repo } = {}) {
  if (!repo) {
    const existing = resolveSyncRepoPath(evoHome, repoPath);
    if (existing) return existing;
  }

  const config = loadStore(evoHome).config;
  const rawTarget = repo || config.syncRepo;
  const parsed = parseRepoTarget(rawTarget);
  if (!parsed) {
    throw new Error(
      "No team sync repository configured. Click Connect Team Repo in Canvas or run evo_sync_repo({ action: 'configure', repo: 'owner/repo' })."
    );
  }
  const cloneDir = repoPath || path.join(evoHome, "sync-repos", slugToDirName(parsed.target));
  if (fs.existsSync(path.join(cloneDir, ".git"))) {
    saveConfig(evoHome, { syncRepoPath: cloneDir, syncRepo: parsed.target });
    return cloneDir;
  }

  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
  if (parsed.isSlug) {
    try {
      await runCmd("gh", ["repo", "clone", parsed.target, cloneDir]);
    } catch {
      await runCmd("git", ["clone", parsed.cloneUrl, cloneDir]);
    }
  } else {
    await runCmd("git", ["clone", parsed.cloneUrl, cloneDir]);
  }
  saveConfig(evoHome, { syncRepoPath: cloneDir, syncRepo: parsed.target });
  return cloneDir;
}

function readTeamFilesFromRepo(targetRepo) {
  const expDir = path.join(targetRepo, "assets", "experiences");
  return {
    rules: readJsonSafe(path.join(expDir, "team-rules.json"), []),
    fixes: readJsonSafe(path.join(expDir, "team-fixes.json"), []),
    knowledge: readJsonSafe(path.join(expDir, "team-knowledge.json"), []),
  };
}

export async function configureSyncRepo(evoHome, { repo = "", createPrivate = false, pushExisting = true } = {}) {
  const trimmed = String(repo || "").trim();
  if (!trimmed) {
    const oldRepoPath = resolveSyncRepoPath(evoHome);
    const remoteFiles = oldRepoPath ? readTeamFilesFromRepo(oldRepoPath) : null;
    const remoteIds = remoteFiles
      ? new Set([
          ...remoteFiles.rules.map((x) => x.id),
          ...remoteFiles.fixes.map((x) => x.id),
          ...remoteFiles.knowledge.map((x) => x.id),
        ])
      : null;
    let removedTeamCount = 0;
    let demotedLocalCount = 0;
    for (const fileName of ["rules.json", "fixes.json", "knowledge.json"]) {
      const filePath = path.join(evoHome, fileName);
      const list = readJsonSafe(filePath, []);
      if (!Array.isArray(list) || !list.length) continue;
      let changed = false;
      const next = [];
      for (const item of list) {
        if (item?.scope !== "team") {
          next.push(item);
          continue;
        }
        changed = true;
        if (remoteIds && !remoteIds.has(item.id)) {
          const { pendingSuccessDelta, pendingFailureDelta, pendingRecallDelta, ...rest } = item;
          next.push({ ...rest, scope: "local" });
          demotedLocalCount++;
        } else {
          removedTeamCount++;
        }
      }
      if (changed) writeJson(filePath, next);
    }
    saveConfig(evoHome, { syncRepo: "", syncRepoPath: "", lastAutoPullAt: "", deletedTeamIds: [] });
    appendEvent(evoHome, { event: "disconnect_sync", removedTeamCount, demotedLocalCount });
    return {
      ok: true,
      disconnected: true,
      syncRepo: "",
      syncRepoPath: "",
      removedTeamCount,
      demotedLocalCount,
    };
  }

  const parsed = parseRepoTarget(trimmed);
  if (!parsed) {
    return {
      ok: false,
      error: "Invalid repository. Enter owner/repo (e.g. my-org/team-evo-data) or a Git clone URL.",
    };
  }

  try {
    if (parsed.isSlug) {
      let existingMeta = null;
      let viewErr = null;
      try {
        const rawMeta = await runCmd("gh", ["repo", "view", parsed.slug, "--json", "name,isPrivate"]);
        existingMeta = JSON.parse(rawMeta);
      } catch (err) {
        viewErr = err;
      }

      if (existingMeta) {
        if (createPrivate) {
          return {
            ok: false,
            error: `Repository ${parsed.slug} already exists. Click Connect Existing instead.`,
          };
        }
        if (existingMeta.isPrivate === false) {
          return {
            ok: false,
            error: `Repository ${parsed.slug} is public. Use a private repository for team experiences.`,
          };
        }
      } else if (createPrivate) {
        await runCmd("gh", [
          "repo",
          "create",
          parsed.slug,
          "--private",
          "--description",
          "Private copilot-evo team experiences store",
        ]);
      } else if (viewErr && /not found|could not resolve to a repository/i.test(viewErr.message)) {
        return {
          ok: false,
          error: `Repository ${parsed.slug} was not found or you lack access.`,
        };
      }
    }

    const cloneDir = path.join(evoHome, "sync-repos", slugToDirName(parsed.target));
    await ensureSyncRepo(evoHome, { repo: parsed.target, repoPath: cloneDir });

    const hasCommits = await hasGitHead(cloneDir);
    if (!hasCommits) {
      const expDir = path.join(cloneDir, "assets", "experiences");
      writeJson(path.join(expDir, "team-knowledge.json"), []);
      writeJson(path.join(expDir, "team-rules.json"), []);
      writeJson(path.join(expDir, "team-fixes.json"), []);
      const readmePath = path.join(cloneDir, "README.md");
      if (!fs.existsSync(readmePath)) {
        fs.writeFileSync(
          readmePath,
          `# ${parsed.slug || "copilot-evo-data"}\n\nPrivate experience store for [copilot-evo](https://github.com/JiaqiZhang-Dev/copilot-evo).\n`,
          "utf8"
        );
      }
      await runGit(cloneDir, ["add", "."]);
      await runGit(cloneDir, ["commit", "-m", "chore(evo): initialize team experience store"]);
      await runGit(cloneDir, ["push", "-u", "origin", "HEAD"]);
    }

    const pullRes = await syncRepoPull(evoHome, { repoPath: cloneDir });
    let pushed = false;
    if (pushExisting) {
      const store = loadStore(evoHome);
      const remoteFiles = readTeamFilesFromRepo(cloneDir);
      const remoteIds = new Set([
        ...remoteFiles.rules.map((x) => x.id),
        ...remoteFiles.fixes.map((x) => x.id),
        ...remoteFiles.knowledge.map((x) => x.id),
      ]);
      const localTeam = [...store.rules, ...store.fixes, ...store.knowledge].filter((x) => x.scope === "team");
      const needsPush =
        (store.config.deletedTeamIds?.length || 0) > 0 ||
        localTeam.some(
          (x) =>
            !remoteIds.has(x.id) ||
            x.pendingSuccessDelta ||
            x.pendingFailureDelta ||
            x.pendingRecallDelta
        );
      if (needsPush) {
        const pushRes = await syncRepoPush(evoHome, { repoPath: cloneDir });
        pushed = Boolean(pushRes?.pushed);
      }
    }

    appendEvent(evoHome, { event: "configure_sync", repo: parsed.target, created: Boolean(createPrivate) });
    return {
      ok: true,
      syncRepo: parsed.target,
      syncRepoPath: cloneDir,
      imported: pullRes.imported || 0,
      updated: pullRes.updated || 0,
      pushed,
    };
  } catch (err) {
    return { ok: false, error: err?.message || "Failed to configure team repository." };
  }
}

export async function syncRepoPull(evoHome, { repoPath, repo } = {}) {
  const targetRepo = await ensureSyncRepo(evoHome, { repoPath, repo });
  const hasCommits = await hasGitHead(targetRepo);
  if (hasCommits) {
    await runGit(targetRepo, ["pull", "--ff-only"]);
  }
  const { rules, fixes, knowledge } = readTeamFilesFromRepo(targetRepo);
  const res = importBundle(evoHome, { bundleData: { rules, fixes, knowledge }, respectDeletedTeamIds: true });
  saveConfig(evoHome, { lastAutoPullAt: new Date().toISOString() });
  appendEvent(evoHome, { event: "sync_pull", imported: res.imported || 0 });
  return { ...res, repoPath: targetRepo };
}

function mergeTeamAssetsForPush(remoteList, localTeamList) {
  const byId = new Map(remoteList.map((item, idx) => [item.id, idx]));
  const merged = [...remoteList];
  for (const local of localTeamList) {
    if (!local?.id) continue;
    const cleanLocal = sanitizePayload(stripLocalSyncFields(local));
    const idx = byId.get(local.id);
    if (idx === undefined) {
      byId.set(local.id, merged.length);
      merged.push(cleanLocal);
      continue;
    }
    const remote = merged[idx];
    const pendingSucc = local.pendingSuccessDelta || 0;
    const pendingFail = local.pendingFailureDelta || 0;
    const pendingRecall = local.pendingRecallDelta || 0;
    const baseSucc = Math.max(0, (local.successCount || 0) - pendingSucc);
    const baseFail = Math.max(0, (local.failureCount || 0) - pendingFail);
    const baseRecall = Math.max(0, (local.recallCount || 0) - pendingRecall);
    const localNewer =
      local.updatedAt && (!remote.updatedAt || Date.parse(local.updatedAt) > Date.parse(remote.updatedAt));
    const next = localNewer ? { ...remote, ...cleanLocal } : { ...remote };
    next.successCount = Math.max(remote.successCount || 0, baseSucc) + pendingSucc;
    next.failureCount = Math.max(remote.failureCount || 0, baseFail) + pendingFail;
    const nextRecall = Math.max(remote.recallCount || 0, baseRecall) + pendingRecall;
    if (nextRecall > 0) next.recallCount = nextRecall;
    merged[idx] = next;
  }
  return merged;
}

export async function syncRepoPush(evoHome, { repoPath, repo, commitMessage } = {}) {
  const targetRepo = await ensureSyncRepo(evoHome, { repoPath, repo });
  const hasCommits = await hasGitHead(targetRepo);
  if (hasCommits) {
    await runGit(targetRepo, ["pull", "--rebase", "--autostash"]);
  }

  const store = loadStore(evoHome);
  const localTeamRules = store.rules.filter((r) => r.scope === "team");
  const localTeamFixes = store.fixes.filter((f) => f.scope === "team");
  const localTeamKnowledge = store.knowledge.filter((k) => k.scope === "team");

  const leakCheckLocal = fullLeakCheck({
    rules: localTeamRules.map(stripLocalSyncFields),
    fixes: localTeamFixes.map(stripLocalSyncFields),
    knowledge: localTeamKnowledge.map(stripLocalSyncFields),
  });
  if (leakCheckLocal.found) {
    return { ok: false, error: "Push aborted: sensitive content detected in team experiences.", leaks: leakCheckLocal.leaks };
  }

  const teamRulesPath = path.join(targetRepo, "assets", "experiences", "team-rules.json");
  const teamFixesPath = path.join(targetRepo, "assets", "experiences", "team-fixes.json");
  const teamKnowledgePath = path.join(targetRepo, "assets", "experiences", "team-knowledge.json");
  const existing = readTeamFilesFromRepo(targetRepo);

  const localTeamIdsByType = new Map([
    ...localTeamRules.map((x) => [x.id, "Rule"]),
    ...localTeamFixes.map((x) => [x.id, "Fix"]),
    ...localTeamKnowledge.map((x) => [x.id, "Knowledge"]),
  ]);
  const deletedSet = new Set(store.config.deletedTeamIds || []);
  const filterRemoteForPush = (remoteList, expectedType) =>
    remoteList.filter(
      (item) =>
        !deletedSet.has(item.id) &&
        (!localTeamIdsByType.has(item.id) || localTeamIdsByType.get(item.id) === expectedType)
    );

  const mergedRules = mergeTeamAssetsForPush(filterRemoteForPush(existing.rules, "Rule"), localTeamRules);
  const mergedFixes = mergeTeamAssetsForPush(filterRemoteForPush(existing.fixes, "Fix"), localTeamFixes);
  const mergedKnowledge = mergeTeamAssetsForPush(
    filterRemoteForPush(existing.knowledge, "Knowledge"),
    localTeamKnowledge
  );

  const leakCheck = fullLeakCheck({ rules: mergedRules, fixes: mergedFixes, knowledge: mergedKnowledge });
  if (leakCheck.found) {
    return { ok: false, error: "Push aborted: leak check failed on merged team experiences.", leaks: leakCheck.leaks };
  }

  writeJson(teamRulesPath, mergedRules);
  writeJson(teamFixesPath, mergedFixes);
  writeJson(teamKnowledgePath, mergedKnowledge);

  const syncBackLocalDeltas = (filePath, remoteMerged) => {
    const remoteById = new Map(remoteMerged.map((a) => [a.id, a]));
    const localList = readJsonSafe(filePath, []);
    let changed = false;
    const nextList = localList.map((item) => {
      const r = remoteById.get(item.id);
      if (!r) return item;
      if (
        item.pendingSuccessDelta ||
        item.pendingFailureDelta ||
        item.pendingRecallDelta ||
        item.successCount !== r.successCount ||
        item.failureCount !== r.failureCount ||
        (r.recallCount && item.recallCount !== r.recallCount)
      ) {
        changed = true;
        const { pendingSuccessDelta, pendingFailureDelta, pendingRecallDelta, ...rest } = item;
        return {
          ...rest,
          successCount: r.successCount,
          failureCount: r.failureCount,
          ...(r.recallCount ? { recallCount: r.recallCount } : {}),
        };
      }
      return item;
    });
    if (changed) writeJson(filePath, nextList);
  };

  const syncFiles = [
    "assets/experiences/team-rules.json",
    "assets/experiences/team-fixes.json",
    "assets/experiences/team-knowledge.json",
  ];
  const status = await runGit(targetRepo, ["status", "--porcelain", ...syncFiles]);
  if (!status) {
    syncBackLocalDeltas(path.join(evoHome, "rules.json"), mergedRules);
    syncBackLocalDeltas(path.join(evoHome, "fixes.json"), mergedFixes);
    syncBackLocalDeltas(path.join(evoHome, "knowledge.json"), mergedKnowledge);
    if (deletedSet.size) saveConfig(evoHome, { deletedTeamIds: [] });
    return { ok: true, pushed: false, message: "Team experiences are already up to date.", repoPath: targetRepo };
  }

  await runGit(targetRepo, ["add", ...syncFiles]);
  await runGit(targetRepo, ["commit", "-m", commitMessage || "chore(evo): sync sanitized team experiences"]);
  await runGit(targetRepo, hasCommits ? ["push"] : ["push", "-u", "origin", "HEAD"]);
  syncBackLocalDeltas(path.join(evoHome, "rules.json"), mergedRules);
  syncBackLocalDeltas(path.join(evoHome, "fixes.json"), mergedFixes);
  syncBackLocalDeltas(path.join(evoHome, "knowledge.json"), mergedKnowledge);
  if (deletedSet.size) saveConfig(evoHome, { deletedTeamIds: [] });
  appendEvent(evoHome, {
    event: "sync_push",
    rulesCount: mergedRules.length,
    fixesCount: mergedFixes.length,
    knowledgeCount: mergedKnowledge.length,
  });
  return {
    ok: true,
    pushed: true,
    rulesCount: mergedRules.length,
    fixesCount: mergedFixes.length,
    knowledgeCount: mergedKnowledge.length,
    repoPath: targetRepo,
  };
}

const DEFAULT_AUTO_PULL_INTERVAL_MS = 30 * 60 * 1000;

export function getPendingScoreDeltaTotal(evoHome) {
  const { rules, fixes, knowledge } = loadStore(evoHome);
  let total = 0;
  for (const item of [...rules, ...fixes, ...knowledge]) {
    if (item.scope !== "team") continue;
    total += (item.pendingSuccessDelta || 0) + (item.pendingFailureDelta || 0);
  }
  return total;
}

export async function maybeAutoPull(evoHome, { repoPath, intervalMs = DEFAULT_AUTO_PULL_INTERVAL_MS } = {}) {
  const targetRepo = resolveSyncRepoPath(evoHome, repoPath);
  if (!targetRepo) return { ok: true, ran: false, reason: "no_local_sync_repo" };
  const { config } = loadStore(evoHome);
  const lastAt = config.lastAutoPullAt ? Date.parse(config.lastAutoPullAt) : 0;
  if (lastAt && Date.now() - lastAt < intervalMs) {
    return { ok: true, ran: false, reason: "throttled" };
  }
  saveConfig(evoHome, { lastAutoPullAt: new Date().toISOString() });
  const res = await syncRepoPull(evoHome, { repoPath: targetRepo });
  return { ...res, ran: true };
}

// Pushes only numeric score deltas for already-published team experiences (never new content).
export async function syncScoreDeltasOnly(evoHome, { repoPath } = {}) {
  const targetRepo = resolveSyncRepoPath(evoHome, repoPath);
  if (!targetRepo) return { ok: true, pushed: false, reason: "no_local_sync_repo" };

  const store = loadStore(evoHome);
  const teamRulesPath = path.join(targetRepo, "assets", "experiences", "team-rules.json");
  const teamFixesPath = path.join(targetRepo, "assets", "experiences", "team-fixes.json");
  const teamKnowledgePath = path.join(targetRepo, "assets", "experiences", "team-knowledge.json");

  await runGit(targetRepo, ["pull", "--rebase", "--autostash"]);
  const existing = readTeamFilesFromRepo(targetRepo);

  const mergeScoresOnly = (remoteList, localList) => {
    const localById = new Map(localList.filter((x) => x.scope === "team").map((x) => [x.id, x]));
    let dirty = false;
    const nextRemote = remoteList.map((remote) => {
      const local = localById.get(remote.id);
      if (!local) return remote;
      const pendingSucc = local.pendingSuccessDelta || 0;
      const pendingFail = local.pendingFailureDelta || 0;
      const pendingRecall = local.pendingRecallDelta || 0;
      if (!pendingSucc && !pendingFail && !pendingRecall) return remote;
      dirty = true;
      const nextRecall = (remote.recallCount || 0) + pendingRecall;
      return {
        ...remote,
        successCount: (remote.successCount || 0) + pendingSucc,
        failureCount: (remote.failureCount || 0) + pendingFail,
        ...(nextRecall > 0 ? { recallCount: nextRecall } : {}),
      };
    });
    return { nextRemote, dirty };
  };

  const rMerge = mergeScoresOnly(existing.rules, store.rules);
  const fMerge = mergeScoresOnly(existing.fixes, store.fixes);
  const kMerge = mergeScoresOnly(existing.knowledge, store.knowledge);
  if (!rMerge.dirty && !fMerge.dirty && !kMerge.dirty) {
    return { ok: true, pushed: false, reason: "no_pending_deltas" };
  }

  if (rMerge.dirty) writeJson(teamRulesPath, rMerge.nextRemote);
  if (fMerge.dirty) writeJson(teamFixesPath, fMerge.nextRemote);
  if (kMerge.dirty) writeJson(teamKnowledgePath, kMerge.nextRemote);

  const syncFiles = [
    "assets/experiences/team-rules.json",
    "assets/experiences/team-fixes.json",
    "assets/experiences/team-knowledge.json",
  ];
  const status = await runGit(targetRepo, ["status", "--porcelain", ...syncFiles]);
  if (status) {
    await runGit(targetRepo, ["add", ...syncFiles]);
    await runGit(targetRepo, ["commit", "-m", "chore(evo): sync experience score deltas"]);
    await runGit(targetRepo, ["push"]);
  }

  const clearLocalDeltas = (filePath, remoteMerged) => {
    const remoteById = new Map(remoteMerged.map((a) => [a.id, a]));
    const list = readJsonSafe(filePath, []);
    let changed = false;
    const nextList = list.map((item) => {
      const r = remoteById.get(item.id);
      if (!r || (!item.pendingSuccessDelta && !item.pendingFailureDelta && !item.pendingRecallDelta)) return item;
      changed = true;
      const { pendingSuccessDelta, pendingFailureDelta, pendingRecallDelta, ...rest } = item;
      return {
        ...rest,
        successCount: r.successCount || 0,
        failureCount: r.failureCount || 0,
        ...(r.recallCount ? { recallCount: r.recallCount } : {}),
      };
    });
    if (changed) writeJson(filePath, nextList);
  };

  clearLocalDeltas(path.join(evoHome, "rules.json"), rMerge.nextRemote);
  clearLocalDeltas(path.join(evoHome, "fixes.json"), fMerge.nextRemote);
  clearLocalDeltas(path.join(evoHome, "knowledge.json"), kMerge.nextRemote);
  appendEvent(evoHome, { event: "sync_scores", reason: "auto_delta_push" });
  return { ok: true, pushed: true, repoPath: targetRepo };
}

export function getGraduationStatus(
  asset,
  {
    currentRepo = "",
    allAssets = [],
    nowMs = Date.now(),
    minSuccess = 3,
    minRecalls = 5,
    minWinRate = 80,
    minScore = 65,
  } = {}
) {
  const succ = Math.max(0, Number(asset?.successCount || 0));
  const recalls = Math.max(0, Number(asset?.recallCount || 0));
  const gdi = asset?.id
    ? computeGdiBreakdown(asset, allAssets.length ? allAssets : [asset], nowMs)
    : { score: 0, tier: "C", winRate: 100 };
  const assetRepo = normalizeRepoSlug(asset?.repoScope || "*");
  const repoScoped = Boolean(asset?.id) && assetRepo !== "*";
  const repoMatches =
    repoScoped &&
    (!currentRepo || currentRepo === "*" || assetRepo.toLowerCase() === normalizeRepoSlug(currentRepo).toLowerCase());
  const graduated = Boolean(asset?.graduatedTo?.targetPath);
  const usageMet = succ >= minSuccess || recalls >= minRecalls;
  const winRateMet = gdi.winRate >= minWinRate;
  const scoreMet = gdi.tier === "S" || gdi.tier === "A" || gdi.score >= minScore;
  return {
    eligible: Boolean(asset?.id && !graduated && repoMatches && usageMet && winRateMet && scoreMet),
    graduated,
    repoScoped,
    repoMatches,
    usageMet,
    winRateMet,
    scoreMet,
    metrics: {
      successCount: succ,
      recallCount: recalls,
      winRate: gdi.winRate,
      score: gdi.score,
      tier: gdi.tier,
    },
    thresholds: { minSuccess, minRecalls, minWinRate, minScore },
  };
}

export function isGraduationCandidate(asset, options = {}) {
  return getGraduationStatus(asset, options).eligible;
}

export function findGraduationCandidates({
  rules = [],
  fixes = [],
  knowledge = [],
  repo = "",
  nowMs = Date.now(),
  minSuccess = 3,
  minRecalls = 5,
  minWinRate = 80,
} = {}) {
  const allAssets = [...rules, ...fixes, ...knowledge];
  return allAssets
    .filter((asset) =>
      isGraduationCandidate(asset, { currentRepo: repo, allAssets, nowMs, minSuccess, minRecalls, minWinRate })
    )
    .map((asset) => ({
      asset,
      gdiScore: computeGdiScore(asset, allAssets, nowMs),
      recommendation: recommendGraduationTarget(asset),
    }))
    .sort((a, b) => b.gdiScore - a.gdiScore);
}

export function recommendGraduationTarget(asset) {
  const type = normalizeExperienceType(asset?.type);
  const rawId = String(asset?.id || asset?.title || "experience")
    .replace(/^exp-/, "")
    .replace(/-[a-z0-9]{8}$/i, "");
  const skillName = slugify(rawId || asset?.title || "experience", 48);
  const stepsCount = Array.isArray(asset?.strategy) ? asset.strategy.length : 0;
  const hasValidation = Array.isArray(asset?.validation) && asset.validation.length > 0;
  if (type === "Fix" || stepsCount >= 3 || hasValidation) {
    return {
      targetType: "skill",
      targetPath: `.github/skills/${skillName}/SKILL.md`,
      skillName,
    };
  }
  return {
    targetType: "copilot-instructions",
    targetPath: ".github/copilot-instructions.md",
    skillName,
  };
}

export function renderGraduationArtifact(
  asset,
  { targetType = "", targetPath = "", skillName = "", existingContent = "" } = {}
) {
  if (!asset?.id) {
    return { ok: false, error: "Experience is required." };
  }
  const leak = fullLeakCheck(asset);
  if (leak.found) {
    return {
      ok: false,
      error: "Graduation blocked: sensitive content detected in experience.",
      leaks: leak.leaks,
    };
  }
  const rec = recommendGraduationTarget(asset);
  const resolvedType = targetType || rec.targetType;
  const resolvedSkill = slugify(skillName || rec.skillName, 48);
  const resolvedPath =
    String(targetPath || "").trim() ||
    (resolvedType === "skill"
      ? `.github/skills/${resolvedSkill}/SKILL.md`
      : resolvedType === "instructions-file"
        ? `.github/instructions/${resolvedSkill}.instructions.md`
        : ".github/copilot-instructions.md");

  const marker = `<!-- copilot-evo: ${asset.id} -->`;
  const kindLabel = normalizeExperienceType(asset.type);
  const steps = Array.isArray(asset.strategy) ? asset.strategy : [];
  const validation = Array.isArray(asset.validation) ? asset.validation : [];

  if (resolvedType === "skill") {
    const descText = String(asset.summary || asset.title || "").replace(/\s+/g, " ").replace(/"/g, "'").trim();
    const lines = [
      "---",
      `name: ${resolvedSkill}`,
      `description: "${descText.slice(0, 240)}"`,
      "---",
      "",
      `# ${asset.title}`,
      "",
      asset.summary,
    ];
    if (asset.solution) {
      lines.push("", "## Solution", "", asset.solution);
    }
    if (steps.length) {
      lines.push("", `## ${kindLabel === "Knowledge" ? "Key Takeaways" : "Steps"}`, "");
      steps.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
    }
    if (validation.length) {
      lines.push("", "## Validation", "", ...validation.map((cmd) => `- \`${cmd}\``));
    }
    lines.push("", marker, "");
    const content = lines.join("\n");
    return {
      ok: true,
      targetType: resolvedType,
      targetPath: resolvedPath,
      skillName: resolvedSkill,
      alreadyPresent: existingContent.includes(marker),
      snippet: content,
      content,
    };
  }

  const snippetLines = [
    `### ${asset.title}`,
    marker,
    "",
    asset.summary,
  ];
  if (asset.solution) {
    snippetLines.push("", `- **Fix:** ${asset.solution}`);
  }
  if (steps.length) {
    snippetLines.push(...steps.map((s) => `- ${s}`));
  }
  if (validation.length) {
    snippetLines.push(`- **Verify:** ${validation.map((v) => `\`${v}\``).join(", ")}`);
  }
  const snippet = snippetLines.join("\n");

  const alreadyPresent =
    Boolean(existingContent) &&
    (existingContent.includes(marker) || existingContent.includes(`### ${asset.title}`));
  if (alreadyPresent) {
    return {
      ok: true,
      targetType: resolvedType,
      targetPath: resolvedPath,
      alreadyPresent: true,
      snippet,
      content: existingContent,
    };
  }

  let content;
  if (!existingContent.trim()) {
    const header =
      resolvedType === "instructions-file"
        ? `---\napplyTo: "**"\n---\n\n## Repository Conventions\n\n`
        : `## Repository Conventions\n\n`;
    content = `${header}${snippet}\n`;
  } else {
    content = `${existingContent.trimEnd()}\n\n${snippet}\n`;
  }

  return {
    ok: true,
    targetType: resolvedType,
    targetPath: resolvedPath,
    alreadyPresent: false,
    snippet,
    content,
  };
}

function normalizeRepoRelativePath(targetPath) {
  const rel = String(targetPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) return "";
  return rel;
}

export function graduateAsset(
  evoHome,
  assetId,
  {
    workingDirectory = process.cwd(),
    targetType = "",
    targetPath = "",
    skillName = "",
    prUrl = "",
    markOnly = false,
    write = false,
  } = {}
) {
  if (!assetId) return { ok: false, error: "Experience ID is required." };
  const store = loadStore(evoHome);
  const sources = [
    { file: "rules.json", list: store.rules },
    { file: "fixes.json", list: store.fixes },
    { file: "knowledge.json", list: store.knowledge },
  ];
  let matchedSource = null;
  let matchedIdx = -1;
  for (const src of sources) {
    const idx = src.list.findIndex((item) => item.id === assetId);
    if (idx !== -1) {
      matchedSource = src;
      matchedIdx = idx;
      break;
    }
  }
  if (!matchedSource) {
    return { ok: false, error: `Experience not found: ${assetId}` };
  }
  const asset = matchedSource.list[matchedIdx];
  const rootDir = path.resolve(workingDirectory || process.cwd());
  if (!fs.existsSync(rootDir)) {
    return { ok: false, error: `Working directory does not exist: ${rootDir}` };
  }

  const rec = recommendGraduationTarget(asset);
  const resolvedType = targetType || rec.targetType;
  const rawRel = targetPath || (resolvedType === rec.targetType ? rec.targetPath : "");
  const safeRel = rawRel ? normalizeRepoRelativePath(rawRel) : "";
  if (rawRel && !safeRel) {
    return { ok: false, error: "Target path must be a relative path inside the repository." };
  }

  const provisional = renderGraduationArtifact(asset, {
    targetType: resolvedType,
    targetPath: safeRel,
    skillName,
  });
  if (!provisional.ok) return provisional;

  const finalRel = normalizeRepoRelativePath(provisional.targetPath);
  const fullPath = path.resolve(rootDir, finalRel);
  if (!fullPath.startsWith(rootDir + path.sep) && fullPath !== rootDir) {
    return { ok: false, error: "Target path escapes repository root." };
  }
  const existingContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
  const rendered = renderGraduationArtifact(asset, {
    targetType: resolvedType,
    targetPath: finalRel,
    skillName,
    existingContent,
  });
  if (!rendered.ok) return rendered;

  if (!write) {
    return {
      ok: true,
      preview: true,
      assetId: asset.id,
      targetType: rendered.targetType,
      targetPath: finalRel,
      fullPath,
      alreadyPresent: rendered.alreadyPresent,
      snippet: rendered.snippet,
      content: rendered.content,
    };
  }

  if (!markOnly) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, rendered.content, "utf8");
  }

  const repoSlug = detectRepoSlug(rootDir) || asset.repoScope || "*";
  const safePrUrl = prUrl ? normalizeEvidenceLink(prUrl)?.url || "" : "";
  const updatedAsset = {
    ...asset,
    graduatedTo: {
      targetType: rendered.targetType,
      targetPath: finalRel,
      repo: repoSlug,
      ...(safePrUrl ? { prUrl: safePrUrl } : {}),
      graduatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  const nextList = [...matchedSource.list];
  nextList[matchedIdx] = updatedAsset;
  writeJson(path.join(evoHome, matchedSource.file), nextList);

  appendEvent(evoHome, {
    event: "graduate",
    assetId: asset.id,
    assetType: asset.type,
    targetType: rendered.targetType,
    targetPath: finalRel,
  });

  return {
    ok: true,
    graduated: true,
    asset: updatedAsset,
    targetType: rendered.targetType,
    targetPath: finalRel,
    fullPath,
    alreadyPresent: rendered.alreadyPresent,
  };
}

function splitArgs(command) {
  const tokens = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export async function runAssetValidation(evoHome, id, workingDirectory) {
  const { rules, fixes, knowledge } = loadStore(evoHome);
  const asset = [...rules, ...fixes, ...knowledge].find((a) => a.id === id);
  if (!asset) return { ok: false, error: `Asset not found: ${id}` };
  const commands = Array.isArray(asset.validation) ? asset.validation.filter(Boolean) : [];
  if (!commands.length) {
    return { ok: false, error: `Asset ${id} has no declared validation commands.` };
  }
  const cwd = workingDirectory && fs.existsSync(workingDirectory) ? workingDirectory : process.cwd();
  const results = [];
  let allPassed = true;

  for (const cmd of commands) {
    if (!isValidationCommandAllowed(cmd)) {
      return { ok: false, error: `Validation command blocked by safety policy: ${cmd}` };
    }
    const parts = splitArgs(cmd);
    const exe = parts[0];
    const args = parts.slice(1);
    const bin = process.platform === "win32" && /^(?:npm|npx)$/i.test(exe) ? `${exe}.cmd` : exe;
    const useShell = process.platform === "win32" && /\.cmd$/i.test(bin);
    const res = await new Promise((resolveRun) => {
      execFile(bin, args, { cwd, timeout: 60000, shell: useShell }, (err, stdout, stderr) => {
        resolveRun({
          command: cmd,
          passed: !err,
          output: sanitizePayload(`${stdout || ""}\n${stderr || ""}`.trim()).slice(0, 600),
        });
      });
    });
    results.push(res);
    if (!res.passed) allPassed = false;
  }

  recordAssetOutcome(evoHome, [id], allPassed ? "success" : "failure", "arena_validation");
  appendEvent(evoHome, {
    event: allPassed ? "validation_pass" : "validation_fail",
    assetId: id,
    assetType: asset.type,
    commands: commands.length,
  });

  return { ok: true, passed: allPassed, assetId: id, results };
}
