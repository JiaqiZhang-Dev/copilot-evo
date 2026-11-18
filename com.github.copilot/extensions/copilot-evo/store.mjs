import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
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

function mergeById(existing, incoming) {
  const seen = new Set(existing.map((item) => item.id));
  const merged = [...existing];
  let added = 0;
  for (const item of incoming) {
    if (item?.id && !seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
      added++;
    }
  }
  return { merged, added };
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
  const lines = [
    `[${asset.type}:${asset.id}] (${asset.scope}) ${asset.title}`,
    `Summary: ${asset.summary}`,
    `Signals: ${(asset.signals || []).join(", ") || "none"}`,
  ];
  if (asset.solution) lines.push(`Solution: ${asset.solution}`);
  if (asset.strategy?.length) {
    lines.push("Strategy:");
    asset.strategy.forEach((step, idx) => lines.push(`  ${idx + 1}. ${step}`));
  }
  if (asset.validation?.length) {
    lines.push(`Validation: ${asset.validation.join(", ")}`);
  }
  return lines.join("\n");
}

export function hashProjectId(workingDirectory) {
  if (!workingDirectory) return "global";
  const base = path.basename(workingDirectory) || "repo";
  const digest = crypto.createHash("sha256").update(workingDirectory).digest("hex").slice(0, 8);
  return `${base}-${digest}`;
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

export function hasStrategyCue(text) {
  return typeof text === "string" && STRATEGY_CUE_RE.test(text);
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

export function selectAssets({ signals = [], query = "", scope = "", kind = "", genes = [], capsules = [], limit = 3 }) {
  const sigSet = new Set(signals.map((s) => String(s).toLowerCase()));
  const terms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const all = [...genes, ...capsules];

  const scored = [];
  for (const asset of all) {
    if (scope && asset.scope !== scope) continue;
    if (kind && asset.type !== kind) continue;
    let score = 0;
    const assetSignals = (asset.signals || []).map((s) => String(s).toLowerCase());
    for (const sig of assetSignals) {
      if (sigSet.has(sig)) score += 3;
    }
    const haystack = `${asset.id || ""} ${asset.title || ""} ${asset.summary || ""} ${assetSignals.join(" ")}`.toLowerCase();
    for (const term of terms) {
      if (haystack.includes(term)) score += 2;
    }
    if (sigSet.size === 0 && terms.length === 0) {
      score = 1;
    }
    if (score > 0) {
      score += Math.min(3, (asset.priority || 0) * 0.1 + (asset.successCount || 0) * 0.2);
      scored.push({ asset, score });
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
  const kind = input.kind === "Capsule" ? "Capsule" : "Gene";
  const scope = input.scope === "team" ? "team" : "local";
  const prefix = kind === "Capsule" ? "capsule" : "gene";
  const id = input.id ? slugify(input.id) : `${prefix}-${slugify(input.title)}-${Date.now().toString(36)}`;

  const validation = Array.isArray(input.validation) ? input.validation.filter(Boolean) : [];
  for (const cmd of validation) {
    if (!isValidationCommandAllowed(cmd)) {
      return {
        ok: false,
        error: `Validation command rejected by safety policy: ${cmd}. Only safe node/npm/npx/pytest/dotnet/cargo/go test commands without shell operators are allowed.`,
      };
    }
  }

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
    list[idx] = { ...list[idx], ...cleanAsset };
  } else {
    cleanAsset.successCount = 1;
    list.push(cleanAsset);
  }
  writeJson(targetFile, list);

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
        ? "Show the full English asset preview (title, summary, signals, strategy/solution) to the user, then ask whether to push it to the team repository via evo_sync_repo(action: 'push')."
        : "Saved locally. Show the asset preview to the user; if broadly reusable and secret-free, ask whether to promote and sync it to the team repo.",
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
    const found = [...genes, ...capsules, ...candidates].find((a) => a.id === id);
    return found ? { ok: true, asset: found } : { ok: false, error: `Asset not found: ${id}` };
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
      return {
        ok: false,
        error: "Cannot promote to team: sensitive pattern or environment secret detected.",
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
  const selectedGenes = genes.filter(filterFn).map((g) => sanitizePayload(g));
  const selectedCapsules = capsules.filter(filterFn).map((c) => sanitizePayload(c));

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
    const gRes = mergeById(readJsonSafe(genesPath, []), valid.filter((a) => a.type === "Gene"));
    const cRes = mergeById(readJsonSafe(capsulesPath, []), valid.filter((a) => a.type === "Capsule"));
    writeJson(genesPath, gRes.merged);
    writeJson(capsulesPath, cRes.merged);
    return { ok: true, imported: gRes.added + cRes.added, promoted: true, rejected };
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
  appendEvent(evoHome, { event: "sync_pull", imported: res.imported || 0 });
  return { ...res, repoPath: targetRepo };
}

export async function syncRepoPush(evoHome, { repoPath, repo, commitMessage } = {}) {
  const targetRepo = await ensureSyncRepo(evoHome, { repoPath, repo });
  await runGit(targetRepo, ["pull", "--rebase", "--autostash"]);

  const exported = exportBundle(evoHome, { scope: "team" });
  if (!exported.ok) return exported;

  const teamGenesPath = path.join(targetRepo, "assets", "gep", "team-genes.json");
  const teamCapsulesPath = path.join(targetRepo, "assets", "gep", "team-capsules.json");
  const existingGenes = readJsonSafe(teamGenesPath, []);
  const existingCapsules = readJsonSafe(teamCapsulesPath, []);

  const mergedGenes = mergeById(existingGenes, exported.bundle.genes).merged;
  const mergedCapsules = mergeById(existingCapsules, exported.bundle.capsules).merged;

  const leakCheck = fullLeakCheck({ genes: mergedGenes, capsules: mergedCapsules });
  if (leakCheck.found) {
    return { ok: false, error: "Push aborted: leak check failed on merged team assets.", leaks: leakCheck.leaks };
  }

  writeJson(teamGenesPath, mergedGenes);
  writeJson(teamCapsulesPath, mergedCapsules);

  const status = await runGit(targetRepo, ["status", "--porcelain", "assets/gep/team-genes.json", "assets/gep/team-capsules.json"]);
  if (!status) {
    return { ok: true, pushed: false, message: "Team assets are already up to date.", repoPath: targetRepo };
  }

  await runGit(targetRepo, ["add", "assets/gep/team-genes.json", "assets/gep/team-capsules.json"]);
  await runGit(targetRepo, ["commit", "-m", commitMessage || "chore(evo): sync sanitized team genes and capsules"]);
  await runGit(targetRepo, ["push"]);
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
