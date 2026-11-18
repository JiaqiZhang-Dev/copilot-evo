import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fullLeakCheck, isValidationCommandAllowed, sanitizePayload } from "./sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const BUNDLED_GEP_DIR = path.join(PLUGIN_ROOT, "assets", "gep");

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
  const bundledDir = options.bundledDir || BUNDLED_GEP_DIR;
  fs.mkdirSync(evoHome, { recursive: true });

  const genesPath = path.join(evoHome, "genes.json");
  const capsulesPath = path.join(evoHome, "capsules.json");
  const candidatesPath = path.join(evoHome, "candidates.json");
  const configPath = path.join(evoHome, "config.json");

  const starterGenes = readJsonSafe(path.join(bundledDir, "starter-genes.json"), []);
  const teamGenes = readJsonSafe(path.join(bundledDir, "team-genes.json"), []);
  const teamCapsules = readJsonSafe(path.join(bundledDir, "team-capsules.json"), []);

  const currentGenes = readJsonSafe(genesPath, []);
  const currentCapsules = readJsonSafe(capsulesPath, []);
  const { merged: mergedGenes } = mergeById(currentGenes, [...starterGenes, ...teamGenes]);
  const { merged: mergedCapsules } = mergeById(currentCapsules, teamCapsules);

  if (!fs.existsSync(genesPath) || mergedGenes.length !== currentGenes.length) {
    writeJson(genesPath, mergedGenes);
  }
  if (!fs.existsSync(capsulesPath) || mergedCapsules.length !== currentCapsules.length) {
    writeJson(capsulesPath, mergedCapsules);
  }
  if (!fs.existsSync(candidatesPath)) {
    writeJson(candidatesPath, []);
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
    genes: readJsonSafe(path.join(evoHome, "genes.json"), []),
    capsules: readJsonSafe(path.join(evoHome, "capsules.json"), []),
    candidates: readJsonSafe(path.join(evoHome, "candidates.json"), []),
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

export function appendEvent(evoHome, event) {
  fs.mkdirSync(evoHome, { recursive: true });
  const cleanEvent = sanitizePayload({
    ts: new Date().toISOString(),
    ...event,
  });
  fs.appendFileSync(path.join(evoHome, "events.jsonl"), `${JSON.stringify(cleanEvent)}\n`, "utf8");
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
  const kindLabel = asset.type === "Capsule" ? "Fix" : "Rule";
  const repoLabel = asset.repoScope && asset.repoScope !== "*" ? ` repo:${asset.repoScope}` : " repo:*";
  const lines = [
    `[EXP · ${kindLabel}:${asset.id}] (${asset.scope}${repoLabel}) ${asset.title}`,
    `Summary: ${asset.summary}`,
    `Signals: ${(asset.signals || []).join(", ") || "none"}`,
  ];
  if (asset.geneId) lines.push(`Derived from Rule: ${asset.geneId}`);
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
  if (asset?.geneId || asset?.parentId || asset?.supersedes) lineage += 25;
  const hasChildren = allAssets.some((a) => a.id !== asset?.id && (a.geneId === asset?.id || a.parentId === asset?.id));
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
  if (!asset) return { parent: null, gene: null, supersedes: null, children: [], supersededBy: [], sharedSignals: [] };
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
    gene: asset.geneId ? pickSummary(byId.get(asset.geneId)) : null,
    parent: asset.parentId ? pickSummary(byId.get(asset.parentId)) : null,
    supersedes: asset.supersedes ? pickSummary(byId.get(asset.supersedes)) : null,
    children: allAssets
      .filter((item) => item.id !== asset.id && (item.parentId === asset.id || item.geneId === asset.id))
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
  const genesPath = path.join(evoHome, "genes.json");
  const capsulesPath = path.join(evoHome, "capsules.json");
  const genes = readJsonSafe(genesPath, []);
  const capsules = readJsonSafe(capsulesPath, []);
  const idSet = new Set(uniqueIds);
  const updated = [];
  let genesDirty = false;
  let capsulesDirty = false;

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

  apply(genes, () => { genesDirty = true; });
  apply(capsules, () => { capsulesDirty = true; });
  if (genesDirty) writeJson(genesPath, genes);
  if (capsulesDirty) writeJson(capsulesPath, capsules);
  if (updated.length) {
    appendEvent(evoHome, { event: `auto_${outcome}`, assetIds: updated, reason });
  }
  return updated;
}

export function hashProjectId(workingDirectory) {
  if (!workingDirectory) return "global";
  const digest = crypto.createHash("sha256").update(workingDirectory).digest("hex").slice(0, 10);
  return `proj-${digest}`;
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
];

const STRATEGY_CUE_RE = /(?:记住|以后|下次|踩坑|经验|策略|规范|沉淀|固化|避免|总是|不要再|\b(?:always|never|remember|pitfall|workaround|lesson|best practice|convention)\b)/i;
const NEGATIVE_FEEDBACK_RE = /(?:不对|没用|无效|还是报错|不行|别这么做|错了|过时|\b(?:wrong|didn't work|did not work|doesn't work|still failing|not helpful|outdated|stop doing)\b)/i;

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
  if (raw === "Capsule" || raw === "Fix") return "Capsule";
  return "Gene";
}

export function selectAssets({
  signals = [],
  query = "",
  scope = "",
  kind = "",
  repo = "",
  includeSuperseded = false,
  genes = [],
  capsules = [],
  limit = 3,
}) {
  const sigSet = new Set(signals.map((s) => String(s).toLowerCase()));
  const terms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const all = [...genes, ...capsules];
  const supersededIds = new Set(all.map((a) => a.supersedes).filter(Boolean));
  const normalizedRepo = repo && repo !== "*" ? normalizeRepoSlug(repo) : "";
  const normalizedKind = kind ? normalizeAssetKind(kind) : "";
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

function slugify(text) {
  return String(text || "asset")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "asset";
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

export function solidifyAsset(input, options = {}) {
  const evoHome = initStore(options);
  const kind = normalizeAssetKind(input.kind);
  const scope = input.scope === "team" ? "team" : "local";
  const id = input.id ? slugify(input.id) : `exp-${slugify(input.title)}-${Date.now().toString(36)}`;

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
    ...(input.geneId ? { geneId: slugify(input.geneId) } : {}),
    ...(input.parentId ? { parentId: slugify(input.parentId) } : {}),
    ...(input.supersedes ? { supersedes: slugify(input.supersedes) } : {}),
    sourceProject: hashProjectId(input.workingDirectory),
    updatedAt: new Date().toISOString(),
  };

  if (hasNonEnglishText(rawAsset)) {
    return {
      ok: false,
      error: "All solidified Genes and Capsules must be written in English. Translate title, summary, signals, strategy, and solution into English and retry evo_solidify.",
    };
  }

  const leakCheck = fullLeakCheck(rawAsset);
  if (scope === "team" && leakCheck.found) {
    return {
      ok: false,
      error: "Team asset rejected: sensitive pattern or environment secret detected. Replace secrets/paths with placeholders before solidifying as team scope.",
      leaks: leakCheck.leaks,
    };
  }

  const cleanAsset = sanitizePayload(rawAsset);
  const targetFile = path.join(evoHome, kind === "Capsule" ? "capsules.json" : "genes.json");
  const list = readJsonSafe(targetFile, []);
  const idx = list.findIndex((item) => item.id === cleanAsset.id);
  if (idx >= 0) {
    cleanAsset.successCount = (list[idx].successCount || 0) + 1;
    cleanAsset.pendingSuccessDelta = (list[idx].pendingSuccessDelta || 0) + 1;
    list[idx] = { ...list[idx], ...cleanAsset };
  } else {
    cleanAsset.successCount = 1;
    if (scope === "team") cleanAsset.pendingSuccessDelta = 1;
    list.push(cleanAsset);
  }
  writeJson(targetFile, list);

  if (cleanAsset.geneId || cleanAsset.parentId) {
    recordAssetOutcome(
      evoHome,
      [cleanAsset.geneId, cleanAsset.parentId].filter(Boolean),
      "success",
      "derived_asset"
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
  const genesPath = path.join(evoHome, "genes.json");
  const capsulesPath = path.join(evoHome, "capsules.json");
  const candidatesPath = path.join(evoHome, "candidates.json");

  const genes = readJsonSafe(genesPath, []);
  const capsules = readJsonSafe(capsulesPath, []);
  const candidates = readJsonSafe(candidatesPath, []);

  if (action === "list_candidates") {
    return { ok: true, candidates };
  }

  if (action === "inspect") {
    const allAssets = [...genes, ...capsules];
    const found = [...allAssets, ...candidates].find((a) => a.id === id);
    if (!found) return { ok: false, error: `Asset not found: ${id}` };
    return {
      ok: true,
      asset: found,
      gdiScore: computeGdiScore(found),
      relationships: getAssetRelationships(found, allAssets),
    };
  }

  if (action === "pin" || action === "unpin" || action === "upvote" || action === "downvote") {
    const targetList = genes.some((a) => a.id === id) ? genes : capsules;
    const idx = targetList.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, error: `Asset not found: ${id}` };
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
    writeJson(targetList === genes ? genesPath : capsulesPath, targetList);
    appendEvent(evoHome, { event: `feedback_${action}`, assetId: current.id, assetType: current.type });
    return { ok: true, asset: current, gdiScore: computeGdiScore(current) };
  }

  if (action === "promote") {
    const idx = candidates.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, error: `Candidate not found: ${id}` };
    const candidate = sanitizePayload(candidates[idx]);
    for (const cmd of candidate.validation || []) {
      if (!isValidationCommandAllowed(cmd)) {
        return { ok: false, error: `Candidate blocked due to unsafe validation command: ${cmd}` };
      }
    }
    const targetPath = candidate.type === "Capsule" ? capsulesPath : genesPath;
    const list = readJsonSafe(targetPath, []);
    if (!list.some((a) => a.id === candidate.id)) {
      list.push(candidate);
      writeJson(targetPath, list);
    }
    candidates.splice(idx, 1);
    writeJson(candidatesPath, candidates);
    appendEvent(evoHome, { event: "promote", assetId: candidate.id, assetType: candidate.type });
    return { ok: true, asset: candidate };
  }

  if (action === "promote_team") {
    const targetList = genes.some((a) => a.id === id) ? genes : capsules;
    const idx = targetList.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, error: `Asset not found: ${id}` };
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
    writeJson(targetList === genes ? genesPath : capsulesPath, targetList);
    appendEvent(evoHome, { event: "promote_team", assetId: clean.id, assetType: clean.type });
    return { ok: true, asset: clean };
  }

  if (action === "delete") {
    const nextGenes = genes.filter((a) => a.id !== id);
    const nextCapsules = capsules.filter((a) => a.id !== id);
    const nextCandidates = candidates.filter((a) => a.id !== id);
    const changed =
      nextGenes.length !== genes.length ||
      nextCapsules.length !== capsules.length ||
      nextCandidates.length !== candidates.length;
    if (!changed) return { ok: false, error: `Asset not found: ${id}` };
    writeJson(genesPath, nextGenes);
    writeJson(capsulesPath, nextCapsules);
    writeJson(candidatesPath, nextCandidates);
    appendEvent(evoHome, { event: "delete", assetId: id });
    return { ok: true, deletedId: id };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}

export function exportBundle(evoHome, { scope = "team", outputPath }) {
  const { genes, capsules } = loadStore(evoHome);
  const filterFn = (item) => (scope === "all" ? item.scope !== "starter" : item.scope === scope);
  const selectedGenes = genes.filter(filterFn).map((g) => sanitizePayload(stripLocalSyncFields(g)));
  const selectedCapsules = capsules.filter(filterFn).map((c) => sanitizePayload(stripLocalSyncFields(c)));

  const bundle = {
    schema: "copilot-evo/bundle@1",
    exportedAt: new Date().toISOString(),
    genes: selectedGenes,
    capsules: selectedCapsules,
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

export function importBundle(evoHome, { inputPath, bundleData, autoPromote = false }) {
  const bundle = bundleData || readJsonSafe(inputPath, null);
  if (!bundle || (!Array.isArray(bundle.genes) && !Array.isArray(bundle.capsules))) {
    return { ok: false, error: "Invalid evolution bundle." };
  }
  const incoming = [
    ...(bundle.genes || []).map((g) => sanitizePayload({ ...g, type: "Gene" })),
    ...(bundle.capsules || []).map((c) => sanitizePayload({ ...c, type: "Capsule" })),
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

  if (autoPromote) {
    const genesPath = path.join(evoHome, "genes.json");
    const capsulesPath = path.join(evoHome, "capsules.json");
    const gRes = mergeById(readJsonSafe(genesPath, []), valid.filter((a) => a.type === "Gene"), { updateExisting: true });
    const cRes = mergeById(readJsonSafe(capsulesPath, []), valid.filter((a) => a.type === "Capsule"), { updateExisting: true });
    writeJson(genesPath, gRes.merged);
    writeJson(capsulesPath, cRes.merged);
    return {
      ok: true,
      imported: gRes.added + cRes.added,
      updated: gRes.updated + cRes.updated,
      promoted: true,
      rejected,
    };
  }

  const candidatesPath = path.join(evoHome, "candidates.json");
  const candRes = mergeById(readJsonSafe(candidatesPath, []), valid);
  writeJson(candidatesPath, candRes.merged);
  return { ok: true, imported: candRes.added, promoted: false, rejected };
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

export async function syncRepoPull(evoHome, { repoPath, repo, autoPromote = true } = {}) {
  const targetRepo = await ensureSyncRepo(evoHome, { repoPath, repo });
  await runGit(targetRepo, ["pull", "--ff-only"]);
  const genes = readJsonSafe(path.join(targetRepo, "assets", "gep", "team-genes.json"), []);
  const capsules = readJsonSafe(path.join(targetRepo, "assets", "gep", "team-capsules.json"), []);
  const res = importBundle(evoHome, { bundleData: { genes, capsules }, autoPromote });
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
  const localTeamGenes = store.genes.filter((g) => g.scope === "team");
  const localTeamCapsules = store.capsules.filter((c) => c.scope === "team");

  const leakCheckLocal = fullLeakCheck({
    genes: localTeamGenes.map(stripLocalSyncFields),
    capsules: localTeamCapsules.map(stripLocalSyncFields),
  });
  if (leakCheckLocal.found) {
    return { ok: false, error: "Push aborted: sensitive content detected in team assets.", leaks: leakCheckLocal.leaks };
  }

  const teamGenesPath = path.join(targetRepo, "assets", "gep", "team-genes.json");
  const teamCapsulesPath = path.join(targetRepo, "assets", "gep", "team-capsules.json");
  const existingGenes = readJsonSafe(teamGenesPath, []);
  const existingCapsules = readJsonSafe(teamCapsulesPath, []);

  const mergedGenes = mergeTeamAssetsForPush(existingGenes, localTeamGenes);
  const mergedCapsules = mergeTeamAssetsForPush(existingCapsules, localTeamCapsules);

  const leakCheck = fullLeakCheck({ genes: mergedGenes, capsules: mergedCapsules });
  if (leakCheck.found) {
    return { ok: false, error: "Push aborted: leak check failed on merged team assets.", leaks: leakCheck.leaks };
  }

  writeJson(teamGenesPath, mergedGenes);
  writeJson(teamCapsulesPath, mergedCapsules);

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

  const status = await runGit(targetRepo, ["status", "--porcelain", "assets/gep/team-genes.json", "assets/gep/team-capsules.json"]);
  if (!status) {
    syncBackLocalDeltas(path.join(evoHome, "genes.json"), mergedGenes);
    syncBackLocalDeltas(path.join(evoHome, "capsules.json"), mergedCapsules);
    return { ok: true, pushed: false, message: "Team assets are already up to date.", repoPath: targetRepo };
  }

  await runGit(targetRepo, ["add", "assets/gep/team-genes.json", "assets/gep/team-capsules.json"]);
  await runGit(targetRepo, ["commit", "-m", commitMessage || "chore(evo): sync sanitized team genes and capsules"]);
  await runGit(targetRepo, ["push"]);
  syncBackLocalDeltas(path.join(evoHome, "genes.json"), mergedGenes);
  syncBackLocalDeltas(path.join(evoHome, "capsules.json"), mergedCapsules);
  appendEvent(evoHome, {
    event: "sync_push",
    genesCount: mergedGenes.length,
    capsulesCount: mergedCapsules.length,
  });
  return {
    ok: true,
    pushed: true,
    genesCount: mergedGenes.length,
    capsulesCount: mergedCapsules.length,
    repoPath: targetRepo,
  };
}

const DEFAULT_AUTO_PULL_INTERVAL_MS = 30 * 60 * 1000;

export function getPendingScoreDeltaTotal(evoHome) {
  const { genes, capsules } = loadStore(evoHome);
  let total = 0;
  for (const item of [...genes, ...capsules]) {
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
  const res = await syncRepoPull(evoHome, { repoPath: targetRepo, autoPromote: true });
  return { ...res, ran: true };
}

// Pushes only numeric score deltas for already-published team experiences (never new content).
export async function syncScoreDeltasOnly(evoHome, { repoPath } = {}) {
  const targetRepo = resolveSyncRepoPath(evoHome, repoPath);
  if (!targetRepo) return { ok: true, pushed: false, reason: "no_local_sync_repo" };

  const store = loadStore(evoHome);
  const teamGenesPath = path.join(targetRepo, "assets", "gep", "team-genes.json");
  const teamCapsulesPath = path.join(targetRepo, "assets", "gep", "team-capsules.json");

  await runGit(targetRepo, ["pull", "--rebase", "--autostash"]);
  const remoteGenes = readJsonSafe(teamGenesPath, []);
  const remoteCapsules = readJsonSafe(teamCapsulesPath, []);

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

  const gMerge = mergeScoresOnly(remoteGenes, store.genes);
  const cMerge = mergeScoresOnly(remoteCapsules, store.capsules);
  if (!gMerge.dirty && !cMerge.dirty) {
    return { ok: true, pushed: false, reason: "no_pending_deltas" };
  }

  writeJson(teamGenesPath, gMerge.nextRemote);
  writeJson(teamCapsulesPath, cMerge.nextRemote);

  const status = await runGit(targetRepo, ["status", "--porcelain", "assets/gep/team-genes.json", "assets/gep/team-capsules.json"]);
  if (status) {
    await runGit(targetRepo, ["add", "assets/gep/team-genes.json", "assets/gep/team-capsules.json"]);
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

  clearLocalDeltas(path.join(evoHome, "genes.json"), gMerge.nextRemote);
  clearLocalDeltas(path.join(evoHome, "capsules.json"), cMerge.nextRemote);
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
  const { genes, capsules } = loadStore(evoHome);
  const asset = [...genes, ...capsules].find((a) => a.id === id);
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
