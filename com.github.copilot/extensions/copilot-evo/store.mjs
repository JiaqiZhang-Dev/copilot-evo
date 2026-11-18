import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fullLeakCheck, isValidationCommandAllowed, sanitizePayload } from "./sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const BUNDLED_EXP_DIR = path.join(PLUGIN_ROOT, "assets", "experiences");

function normalizeExperienceType(rawType) {
  return rawType === "Fix" ? "Fix" : "Rule";
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
  const { pendingSuccessDelta, pendingFailureDelta, ...rest } = asset;
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
      const baseSucc = Math.max(0, (cur.successCount || 0) - pendingSucc);
      const baseFail = Math.max(0, (cur.failureCount || 0) - pendingFail);
      const nextSucc = Math.max(item.successCount || 0, baseSucc) + pendingSucc;
      const nextFail = Math.max(item.failureCount || 0, baseFail) + pendingFail;
      const incomingNewer =
        item.updatedAt && (!cur.updatedAt || Date.parse(item.updatedAt) > Date.parse(cur.updatedAt));
      const nextItem = incomingNewer ? { ...cur, ...item } : { ...cur };
      nextItem.successCount = nextSucc;
      nextItem.failureCount = nextFail;
      if (pendingSucc) nextItem.pendingSuccessDelta = pendingSucc;
      if (pendingFail) nextItem.pendingFailureDelta = pendingFail;
      if (JSON.stringify(nextItem) !== JSON.stringify(cur)) {
        merged[existingIdx] = nextItem;
        updated++;
      }
    }
  }
  return { merged, added, updated };
}

function getDefaultSyncRepoSlug() {
  const pkg = readJsonSafe(path.join(PLUGIN_ROOT, "plugin.json"), null);
  const owner = pkg?.author?.name || "JiaqiZhang-Dev";
  const name = pkg?.name || "copilot-evo";
  return `${owner}/${name}`;
}

export function initStore(options = {}) {
  const evoHome = getEvoHome(options.evoHome);
  const bundledDir = options.bundledDir || BUNDLED_EXP_DIR;
  fs.mkdirSync(evoHome, { recursive: true });

  const rulesPath = path.join(evoHome, "rules.json");
  const fixesPath = path.join(evoHome, "fixes.json");
  const configPath = path.join(evoHome, "config.json");

  const starterRules = readJsonSafe(path.join(bundledDir, "starter-rules.json"), []);
  const teamRules = readJsonSafe(path.join(bundledDir, "team-rules.json"), []);
  const teamFixes = readJsonSafe(path.join(bundledDir, "team-fixes.json"), []);

  const currentRules = readJsonSafe(rulesPath, []);
  const currentFixes = readJsonSafe(fixesPath, []);
  const { merged: mergedRules } = mergeById(currentRules, [...starterRules, ...teamRules]);
  const { merged: mergedFixes } = mergeById(currentFixes, teamFixes);

  if (!fs.existsSync(rulesPath) || mergedRules.length !== currentRules.length) {
    writeJson(rulesPath, mergedRules);
  }
  if (!fs.existsSync(fixesPath) || mergedFixes.length !== currentFixes.length) {
    writeJson(fixesPath, mergedFixes);
  }
  if (!fs.existsSync(configPath)) {
    writeJson(configPath, {
      syncRepoPath: "",
      syncRepo: getDefaultSyncRepoSlug(),
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
    config: readJsonSafe(path.join(evoHome, "config.json"), {
      syncRepoPath: "",
      syncRepo: getDefaultSyncRepoSlug(),
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
    lines.push("Steps:");
    asset.strategy.forEach((step, idx) => lines.push(`  ${idx + 1}. ${step}`));
  }
  if (asset.validation?.length) {
    lines.push(`Validation: ${asset.validation.join(", ")}`);
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

  // 1. Intrinsic Quality (35%): completeness, actionable steps, signals, validation.
  let quality = 25;
  if (String(asset?.title || "").trim().length >= 8) quality += 15;
  if (String(asset?.summary || "").trim().length >= 20) quality += 15;
  if (Array.isArray(asset?.signals) && asset.signals.length >= 2) quality += 15;
  if ((Array.isArray(asset?.strategy) && asset.strategy.length >= 2) || String(asset?.solution || "").trim().length >= 15) {
    quality += 15;
  }
  if (Array.isArray(asset?.validation) && asset.validation.length > 0) quality += 15;
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
  const rules = readJsonSafe(rulesPath, []);
  const fixes = readJsonSafe(fixesPath, []);
  const idSet = new Set(uniqueIds);
  const updated = [];
  let rulesDirty = false;
  let fixesDirty = false;

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
  if (rulesDirty) writeJson(rulesPath, rules);
  if (fixesDirty) writeJson(fixesPath, fixes);
  if (updated.length) {
    appendEvent(evoHome, { event: `auto_${outcome}`, assetIds: updated, reason });
  }
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

export function collectAssetsToCreditOnStop(state, { stopHookActive = false } = {}) {
  if (stopHookActive || !state) return [];
  if ((state.turnActionTools || 0) <= 0) return [];
  if (state.turnHadCorrection || state.turnHadNegativeFeedback) return [];
  const recalled = Array.isArray(state.turnRecalledIds) ? state.turnRecalledIds : [];
  const credited = state.creditedAssets instanceof Set ? state.creditedAssets : new Set();
  return Array.from(new Set(recalled.filter((id) => id && !credited.has(id))));
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

export function selectAssets({
  signals = [],
  query = "",
  scope = "",
  kind = "",
  repo = "",
  isReview = false,
  includeSuperseded = false,
  rules = [],
  fixes = [],
  limit = 3,
}) {
  const sigSet = new Set(signals.map((s) => String(s).toLowerCase()));
  const terms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const all = [...rules, ...fixes];
  const supersededIds = new Set(all.map((a) => a.supersedes).filter(Boolean));
  const normalizedRepo = repo && repo !== "*" ? normalizeRepoSlug(repo) : "";
  const normalizedKind = kind ? normalizeAssetKind(kind) : "";
  const reviewContext = Boolean(isReview || sigSet.has("pr_review"));
  const nowMs = Date.now();

  const scored = [];
  for (const asset of all) {
    if (scope && asset.scope !== scope) continue;
    if (normalizedKind && asset.type !== normalizedKind) continue;
    if (!includeSuperseded && supersededIds.has(asset.id) && !terms.includes(asset.id.toLowerCase())) continue;

    const assetRepo = normalizeRepoSlug(asset.repoScope || "*");
    if (assetRepo !== "*" && normalizedRepo && assetRepo.toLowerCase() !== normalizedRepo.toLowerCase()) continue;
    if (assetRepo !== "*" && !normalizedRepo && !terms.length && sigSet.size > 0) continue;

    let relevance = 0;
    const assetSignals = (asset.signals || []).map((s) => String(s).toLowerCase());
    for (const sig of assetSignals) {
      if (sigSet.has(sig)) relevance += 3;
    }
    const haystack = `${asset.id || ""} ${asset.title || ""} ${asset.summary || ""} ${assetSignals.join(" ")}`.toLowerCase();
    for (const term of terms) {
      if (haystack.includes(term)) relevance += 2;
    }
    if (reviewContext && normalizedRepo && assetRepo.toLowerCase() === normalizedRepo.toLowerCase()) {
      relevance = Math.max(relevance, 2);
    }
    if (sigSet.size === 0 && terms.length === 0) {
      relevance = 1;
    }
    if (relevance > 0) {
      const repoBoost = assetRepo !== "*" && normalizedRepo && assetRepo.toLowerCase() === normalizedRepo.toLowerCase() ? 1.5 : 0;
      const gdiScore = computeGdiScore(asset, all, nowMs);
      scored.push({ asset, score: relevance + repoBoost + gdiScore * 0.05, gdiScore });
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

  const resolvedRepoScope =
    input.repoScope === "current"
      ? detectRepoSlug(input.workingDirectory) || "*"
      : normalizeRepoSlug(input.repoScope || "*");

  const author = (input.author || detectAuthorName(input.workingDirectory) || "").trim();

  const rawAsset = {
    id,
    type: kind,
    title: input.title,
    summary: input.summary,
    signals: Array.isArray(input.signals) ? input.signals.map((s) => String(s).toLowerCase()) : [],
    strategy: Array.isArray(input.strategy) ? input.strategy : [],
    solution: input.solution || "",
    validation,
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
      error: "All solidified Rules and Fixes must be written in English. Translate title, summary, signals, strategy, and solution into English and retry evo_solidify.",
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
  const targetFile = path.join(evoHome, kind === "Fix" ? "fixes.json" : "rules.json");
  const list = readJsonSafe(targetFile, []);
  const idx = list.findIndex((item) => item.id === cleanAsset.id);

  if (idx < 0 && !input.allowDuplicate && !input.supersedes) {
    const store = loadStore(evoHome);
    const similarCandidates = findSimilarAssets(cleanAsset, [...store.rules, ...store.fixes]);
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

  if (idx >= 0) {
    cleanAsset.successCount = (list[idx].successCount || 0) + 1;
    cleanAsset.pendingSuccessDelta = (list[idx].pendingSuccessDelta || 0) + 1;
    if (list[idx].author && !input.author) cleanAsset.author = list[idx].author;
    if (list[idx].sourceProject && !list[idx].sourceProject.startsWith("proj-")) {
      cleanAsset.sourceProject = list[idx].sourceProject;
    }
    list[idx] = { ...list[idx], ...cleanAsset };
  } else {
    cleanAsset.successCount = 1;
    if (scope === "team") cleanAsset.pendingSuccessDelta = 1;
    list.push(cleanAsset);
  }
  writeJson(targetFile, list);

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

  const rules = readJsonSafe(rulesPath, []);
  const fixes = readJsonSafe(fixesPath, []);

  if (action === "inspect") {
    const allAssets = [...rules, ...fixes];
    const found = allAssets.find((a) => a.id === id);
    if (!found) return { ok: false, error: `Experience not found: ${id}` };
    return {
      ok: true,
      asset: found,
      gdiScore: computeGdiScore(found),
      relationships: getAssetRelationships(found, allAssets),
    };
  }

  if (action === "pin" || action === "unpin" || action === "upvote" || action === "downvote") {
    const targetList = rules.some((a) => a.id === id) ? rules : fixes;
    const idx = targetList.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, error: `Experience not found: ${id}` };
    const current = { ...targetList[idx] };
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
    targetList[idx] = current;
    writeJson(targetList === rules ? rulesPath : fixesPath, targetList);
    appendEvent(evoHome, { event: `feedback_${action}`, assetId: current.id, assetType: current.type });
    return { ok: true, asset: current, gdiScore: computeGdiScore(current) };
  }

  if (action === "promote_team") {
    const targetList = rules.some((a) => a.id === id) ? rules : fixes;
    const idx = targetList.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, error: `Experience not found: ${id}` };
    const candidate = { ...targetList[idx], scope: "team", updatedAt: new Date().toISOString() };
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
    targetList[idx] = clean;
    writeJson(targetList === rules ? rulesPath : fixesPath, targetList);
    appendEvent(evoHome, { event: "promote_team", assetId: clean.id, assetType: clean.type });
    return { ok: true, asset: clean };
  }

  if (action === "delete") {
    const nextRules = rules.filter((a) => a.id !== id);
    const nextFixes = fixes.filter((a) => a.id !== id);
    const changed = nextRules.length !== rules.length || nextFixes.length !== fixes.length;
    if (!changed) return { ok: false, error: `Experience not found: ${id}` };
    writeJson(rulesPath, nextRules);
    writeJson(fixesPath, nextFixes);
    appendEvent(evoHome, { event: "delete", assetId: id });
    return { ok: true, deletedId: id };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}

export function exportBundle(evoHome, { scope = "team", outputPath }) {
  const { rules, fixes } = loadStore(evoHome);
  const filterFn = (item) => (scope === "all" ? item.scope !== "starter" : item.scope === scope);
  const selectedRules = rules.filter(filterFn).map((r) => sanitizePayload(stripLocalSyncFields(r)));
  const selectedFixes = fixes.filter(filterFn).map((f) => sanitizePayload(stripLocalSyncFields(f)));

  const bundle = {
    schema: "copilot-evo/bundle@1",
    exportedAt: new Date().toISOString(),
    rules: selectedRules,
    fixes: selectedFixes,
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

export function importBundle(evoHome, { inputPath, bundleData }) {
  const bundle = bundleData || readJsonSafe(inputPath, null);
  if (!bundle || (!Array.isArray(bundle.rules) && !Array.isArray(bundle.fixes))) {
    return { ok: false, error: "Invalid experience bundle." };
  }
  const incoming = [
    ...(bundle.rules || []).map((r) => sanitizePayload({ ...r, type: "Rule" })),
    ...(bundle.fixes || []).map((f) => sanitizePayload({ ...f, type: "Fix" })),
  ];

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

  const rulesPath = path.join(evoHome, "rules.json");
  const fixesPath = path.join(evoHome, "fixes.json");
  const rRes = mergeById(readJsonSafe(rulesPath, []), valid.filter((a) => a.type === "Rule"), {
    updateExisting: true,
  });
  const fRes = mergeById(readJsonSafe(fixesPath, []), valid.filter((a) => a.type === "Fix"), {
    updateExisting: true,
  });
  writeJson(rulesPath, rRes.merged);
  writeJson(fixesPath, fRes.merged);
  return {
    ok: true,
    imported: rRes.added + fRes.added,
    updated: rRes.updated + fRes.updated,
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

export function resolveSyncRepoPath(evoHome, explicitPath) {
  const config = loadStore(evoHome).config;
  const candidates = [
    explicitPath,
    config.syncRepoPath,
    process.env.COPILOT_EVO_SYNC_REPO,
    path.join(evoHome, "sync-repo"),
    path.join(os.homedir(), "copilot-evo"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
  }
  return null;
}

// Clones the configured private plugin repo if a teammate has not cloned it locally yet.
async function ensureSyncRepo(evoHome, { repoPath, repo } = {}) {
  const existing = resolveSyncRepoPath(evoHome, repoPath);
  if (existing) return existing;

  const config = loadStore(evoHome).config;
  const targetSlug = repo || config.syncRepo || getDefaultSyncRepoSlug();
  const cloneDir = repoPath || path.join(evoHome, "sync-repo");
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });

  const cloneUrl = /^(?:https?:\/\/|git@|file:\/\/)/.test(targetSlug)
    ? targetSlug
    : `https://github.com/${targetSlug}.git`;
  try {
    await runCmd("gh", ["repo", "clone", targetSlug, cloneDir]);
  } catch {
    await runCmd("git", ["clone", cloneUrl, cloneDir]);
  }
  saveConfig(evoHome, { syncRepoPath: cloneDir, syncRepo: targetSlug });
  return cloneDir;
}

function readTeamFilesFromRepo(targetRepo) {
  const expDir = path.join(targetRepo, "assets", "experiences");
  return {
    rules: readJsonSafe(path.join(expDir, "team-rules.json"), []),
    fixes: readJsonSafe(path.join(expDir, "team-fixes.json"), []),
  };
}

export async function syncRepoPull(evoHome, { repoPath, repo } = {}) {
  const targetRepo = await ensureSyncRepo(evoHome, { repoPath, repo });
  await runGit(targetRepo, ["pull", "--ff-only"]);
  const { rules, fixes } = readTeamFilesFromRepo(targetRepo);
  const res = importBundle(evoHome, { bundleData: { rules, fixes } });
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
    const baseSucc = Math.max(0, (local.successCount || 0) - pendingSucc);
    const baseFail = Math.max(0, (local.failureCount || 0) - pendingFail);
    const localNewer =
      local.updatedAt && (!remote.updatedAt || Date.parse(local.updatedAt) > Date.parse(remote.updatedAt));
    const next = localNewer ? { ...remote, ...cleanLocal } : { ...remote };
    next.successCount = Math.max(remote.successCount || 0, baseSucc) + pendingSucc;
    next.failureCount = Math.max(remote.failureCount || 0, baseFail) + pendingFail;
    merged[idx] = next;
  }
  return merged;
}

export async function syncRepoPush(evoHome, { repoPath, repo, commitMessage } = {}) {
  const targetRepo = await ensureSyncRepo(evoHome, { repoPath, repo });
  await runGit(targetRepo, ["pull", "--rebase", "--autostash"]);

  const store = loadStore(evoHome);
  const localTeamRules = store.rules.filter((r) => r.scope === "team");
  const localTeamFixes = store.fixes.filter((f) => f.scope === "team");

  const leakCheckLocal = fullLeakCheck({
    rules: localTeamRules.map(stripLocalSyncFields),
    fixes: localTeamFixes.map(stripLocalSyncFields),
  });
  if (leakCheckLocal.found) {
    return { ok: false, error: "Push aborted: sensitive content detected in team experiences.", leaks: leakCheckLocal.leaks };
  }

  const teamRulesPath = path.join(targetRepo, "assets", "experiences", "team-rules.json");
  const teamFixesPath = path.join(targetRepo, "assets", "experiences", "team-fixes.json");
  const existing = readTeamFilesFromRepo(targetRepo);

  const mergedRules = mergeTeamAssetsForPush(existing.rules, localTeamRules);
  const mergedFixes = mergeTeamAssetsForPush(existing.fixes, localTeamFixes);

  const leakCheck = fullLeakCheck({ rules: mergedRules, fixes: mergedFixes });
  if (leakCheck.found) {
    return { ok: false, error: "Push aborted: leak check failed on merged team experiences.", leaks: leakCheck.leaks };
  }

  writeJson(teamRulesPath, mergedRules);
  writeJson(teamFixesPath, mergedFixes);

  const syncBackLocalDeltas = (filePath, remoteMerged) => {
    const remoteById = new Map(remoteMerged.map((a) => [a.id, a]));
    const localList = readJsonSafe(filePath, []);
    let changed = false;
    const nextList = localList.map((item) => {
      const r = remoteById.get(item.id);
      if (!r) return item;
      if (item.pendingSuccessDelta || item.pendingFailureDelta || item.successCount !== r.successCount || item.failureCount !== r.failureCount) {
        changed = true;
        const { pendingSuccessDelta, pendingFailureDelta, ...rest } = item;
        return { ...rest, successCount: r.successCount, failureCount: r.failureCount };
      }
      return item;
    });
    if (changed) writeJson(filePath, nextList);
  };

  const status = await runGit(targetRepo, ["status", "--porcelain", "assets/experiences/team-rules.json", "assets/experiences/team-fixes.json"]);
  if (!status) {
    syncBackLocalDeltas(path.join(evoHome, "rules.json"), mergedRules);
    syncBackLocalDeltas(path.join(evoHome, "fixes.json"), mergedFixes);
    return { ok: true, pushed: false, message: "Team experiences are already up to date.", repoPath: targetRepo };
  }

  await runGit(targetRepo, ["add", "assets/experiences/team-rules.json", "assets/experiences/team-fixes.json"]);
  await runGit(targetRepo, ["commit", "-m", commitMessage || "chore(evo): sync sanitized team rules and fixes"]);
  await runGit(targetRepo, ["push"]);
  syncBackLocalDeltas(path.join(evoHome, "rules.json"), mergedRules);
  syncBackLocalDeltas(path.join(evoHome, "fixes.json"), mergedFixes);
  appendEvent(evoHome, {
    event: "sync_push",
    rulesCount: mergedRules.length,
    fixesCount: mergedFixes.length,
  });
  return {
    ok: true,
    pushed: true,
    rulesCount: mergedRules.length,
    fixesCount: mergedFixes.length,
    repoPath: targetRepo,
  };
}

const DEFAULT_AUTO_PULL_INTERVAL_MS = 30 * 60 * 1000;

export function getPendingScoreDeltaTotal(evoHome) {
  const { rules, fixes } = loadStore(evoHome);
  let total = 0;
  for (const item of [...rules, ...fixes]) {
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
      if (!pendingSucc && !pendingFail) return remote;
      dirty = true;
      return {
        ...remote,
        successCount: (remote.successCount || 0) + pendingSucc,
        failureCount: (remote.failureCount || 0) + pendingFail,
      };
    });
    return { nextRemote, dirty };
  };

  const rMerge = mergeScoresOnly(existing.rules, store.rules);
  const fMerge = mergeScoresOnly(existing.fixes, store.fixes);
  if (!rMerge.dirty && !fMerge.dirty) {
    return { ok: true, pushed: false, reason: "no_pending_deltas" };
  }

  writeJson(teamRulesPath, rMerge.nextRemote);
  writeJson(teamFixesPath, fMerge.nextRemote);

  const status = await runGit(targetRepo, ["status", "--porcelain", "assets/experiences/team-rules.json", "assets/experiences/team-fixes.json"]);
  if (status) {
    await runGit(targetRepo, ["add", "assets/experiences/team-rules.json", "assets/experiences/team-fixes.json"]);
    await runGit(targetRepo, ["commit", "-m", "chore(evo): sync experience score deltas"]);
    await runGit(targetRepo, ["push"]);
  }

  const clearLocalDeltas = (filePath, remoteMerged) => {
    const remoteById = new Map(remoteMerged.map((a) => [a.id, a]));
    const list = readJsonSafe(filePath, []);
    let changed = false;
    const nextList = list.map((item) => {
      const r = remoteById.get(item.id);
      if (!r || (!item.pendingSuccessDelta && !item.pendingFailureDelta)) return item;
      changed = true;
      const { pendingSuccessDelta, pendingFailureDelta, ...rest } = item;
      return { ...rest, successCount: r.successCount || 0, failureCount: r.failureCount || 0 };
    });
    if (changed) writeJson(filePath, nextList);
  };

  clearLocalDeltas(path.join(evoHome, "rules.json"), rMerge.nextRemote);
  clearLocalDeltas(path.join(evoHome, "fixes.json"), fMerge.nextRemote);
  appendEvent(evoHome, { event: "sync_scores", reason: "auto_delta_push" });
  return { ok: true, pushed: true, repoPath: targetRepo };
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
  const { rules, fixes } = loadStore(evoHome);
  const asset = [...rules, ...fixes].find((a) => a.id === id);
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
