import fs from "node:fs";
import path from "node:path";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { createEvoCanvasServer } from "./canvas-server.mjs";
import { sanitizePayload } from "./sanitize.mjs";
import {
  appendEvent,
  countEvents,
  detectRepoSlug,
  detectSourceLabel,
  exportBundle,
  extractSignals,
  formatAssetPreview,
  getPendingScoreDeltaTotal,
  hasCorrectionOrPitfallCue,
  hasNegativeFeedbackCue,
  hasStrategyCue,
  hashProjectId,
  importBundle,
  initStore,
  isTrivialToolFailure,
  loadStore,
  manageAsset,
  maybeAutoPull,
  recordAssetOutcome,
  resolveSyncRepoPath,
  selectAssets,
  setEventSessionContext,
  solidifyAsset,
  syncRepoPull,
  syncRepoPush,
  syncScoreDeltasOnly,
} from "./store.mjs";

const evoHome = initStore();
const EXTENSION_VERSION = "0.10.22";
let lastWorkingDirectory = process.cwd();
let activeSession = null;

function getActiveSessionMeta() {
  const repo = detectRepoSlug(lastWorkingDirectory);
  const project = detectSourceLabel(lastWorkingDirectory);
  if (!activeSession?.sessionId) {
    return {
      ...(repo ? { repo } : {}),
      ...(project ? { project } : {}),
    };
  }
  let sessionName = "";
  const wsPath = activeSession.workspacePath;
  if (wsPath) {
    try {
      const yamlPath = path.join(wsPath, "workspace.yaml");
      if (fs.existsSync(yamlPath)) {
        const yaml = fs.readFileSync(yamlPath, "utf8");
        const m = yaml.match(/^name:\s*(.+)$/m);
        if (m?.[1]) {
          sessionName = m[1].trim().replace(/^["']|["']$/g, "").slice(0, 48);
        }
      }
    } catch {
      // Ignore workspace.yaml read failure.
    }
  }
  return {
    sessionId: activeSession.sessionId,
    ...(sessionName ? { sessionName } : {}),
    ...(repo ? { repo } : {}),
    ...(project ? { project } : {}),
  };
}

setEventSessionContext(getActiveSessionMeta);

const canvasServer = createEvoCanvasServer({
  evoHome,
  getCurrentRepo: () => detectRepoSlug(lastWorkingDirectory),
  getWorkingDirectory: () => lastWorkingDirectory,
  getSessionInfo: getActiveSessionMeta,
  onRefineRequest: async ({ asset, feedback }) => {
    if (!activeSession) throw new Error("Active session unavailable.");
    const prompt = [
      `[copilot-evo refine request] Please update experience \`${asset.id}\` (${asset.type}, scope: ${asset.scope || "local"}, repoScope: ${asset.repoScope || "*"}) based on this user feedback:`,
      `Feedback: ${feedback}`,
      "",
      "Current experience JSON:",
      JSON.stringify(
        {
          id: asset.id,
          kind: asset.type,
          title: asset.title,
          summary: asset.summary,
          signals: asset.signals,
          strategy: asset.strategy,
          solution: asset.solution,
          validation: asset.validation,
          scope: asset.scope || "local",
          repoScope: asset.repoScope || "*",
        },
        null,
        2
      ),
      "",
      "Translate any non-English feedback into concise English, call `evo_solidify` with the same `id` and `scope` to update it in place, and show the updated preview.",
    ].join("\n");
    await activeSession.send({ prompt });
  },
});
const sessionState = {
  protocolInjected: false,
  pendingFailure: null,
  pendingCorrection: null,
  activeAssets: [],
  recentFailureFingerprints: new Map(),
  recentRecallAt: new Map(),
  lastSolidifyAt: 0,
  recentFailures: [],
  recoveries: 0,
  solidifiedCount: 0,
  lastSolidifiedLocalId: "",
  promptQueue: Promise.resolve(),
};

const RECALL_LOG_COOLDOWN_MS = 5 * 60 * 1000;

function recordRecallEvent(matched, { trigger, signals = [], toolName = "" } = {}) {
  if (!Array.isArray(matched) || !matched.length) return;
  const now = Date.now();
  const toLog = matched.filter((asset) => {
    const last = sessionState.recentRecallAt.get(asset.id) || 0;
    return now - last >= RECALL_LOG_COOLDOWN_MS;
  });
  if (!toLog.length) return;
  for (const asset of toLog) {
    sessionState.recentRecallAt.set(asset.id, now);
  }
  appendEvent(evoHome, {
    event: "recall",
    trigger: trigger || "prompt",
    ...(toolName ? { toolName } : {}),
    assetIds: toLog.map((a) => a.id),
    assetTitles: toLog.map((a) => a.title),
    signals: signals.slice(0, 6),
  });
  canvasServer.broadcastUpdate("recall");
}

const ACTIVE_PROTOCOL = [
  "[copilot-evo active protocol]",
  "1. Extension tools (`evo_solidify`, `evo_sync_repo`, `evo_search`, `evo_status`, `evo_manage_asset`) may be deferred; load them with `tool_search_tool` whenever needed.",
  "2. Auto-discover & solidify atomically locally first (English only): Proactively call `evo_solidify` with `scope: \"local\"` whenever you resolve a non-obvious error (`kind: \"Fix\"`), fix a user-reported mistake or platform/rendering quirk (even when no tool errored), or when the user states/verifies reusable conventions (`kind: \"Rule\"`, even if also saved via `store_memory`). Skip trivial typos. Keep each Experience ATOMIC (one focused topic, 2-4 targeted signals, 1-3 concise steps); split distinct concerns into separate `evo_solidify` calls instead of bundling them into one mega-entry. Write ALL solidified fields (`title`, `summary`, `signals`, `strategy`, `solution`) in concise English.",
  "3. Preview & MUST ask via `ask_user` before sharing to team: Immediately after `evo_solidify` succeeds with `scope: \"local\"`, show the concise English preview (`id`, `title`, `summary`, `signals`, `strategy`/`solution`) AND, if `evo_solidify` did not already prompt via native UI (`sharedToTeam` is unset), call `ask_user` with choices `[\"Keep local (Recommended)\", \"Share to Team (promote & push)\"]`. Only call `evo_manage_asset({ action: \"promote_team\", id })` and `evo_sync_repo({ action: \"push\" })` after explicit user confirmation.",
].join("\n");

function formatAssetsContext(assets) {
  if (!assets.length) return "";
  const lines = assets.map((a) => {
    const steps = a.strategy?.length ? ` Steps: ${a.strategy.slice(0, 3).join(" -> ")}` : "";
    const fix = a.solution ? ` Fix: ${a.solution}` : "";
    return `- [${a.type}:${a.id}] ${a.title}: ${a.summary}${fix}${steps}`;
  });
  return `[copilot-evo recalled experiences]\n${lines.join("\n")}`;
}

const session = await joinSession({
  hooks: {
    onSessionStart: async (input) => {
      initStore({ evoHome });
      if (input.workingDirectory) lastWorkingDirectory = input.workingDirectory;
      maybeAutoPull(evoHome)
        .then((res) => {
          if (res?.ran && (res.imported || res.updated)) {
            canvasServer.broadcastUpdate("auto_pull");
          }
        })
        .catch(() => {});
      const currentRepo = detectRepoSlug(lastWorkingDirectory);
      const { rules, fixes, config } = loadStore(evoHome);
      const signals = extractSignals(input.initialPrompt || "", [], { includePlatform: false });
      const matched = signals.length
        ? selectAssets({ signals, repo: currentRepo, rules, fixes, limit: config.autoInjectLimit || 3 })
        : [];
      sessionState.protocolInjected = true;
      sessionState.activeAssets = matched.map((a) => a.id);
      if (matched.length) {
        recordRecallEvent(matched, { trigger: "session_start", signals });
      }
      const parts = [ACTIVE_PROTOCOL];
      if (matched.length) parts.push(formatAssetsContext(matched));
      return { additionalContext: parts.join("\n\n") };
    },

    onUserPromptSubmitted: async (input) => {
      if (input.workingDirectory) lastWorkingDirectory = input.workingDirectory;
      const currentRepo = detectRepoSlug(lastWorkingDirectory);
      const { rules, fixes, config } = loadStore(evoHome);
      const failureSignals = sessionState.recentFailures.flatMap((f) => f.signals);
      const signals = extractSignals(input.prompt, failureSignals, { includePlatform: false });
      const matched =
        signals.length || hasStrategyCue(input.prompt)
          ? selectAssets({
              signals,
              query: input.prompt,
              repo: currentRepo,
              rules,
              fixes,
              limit: config.autoInjectLimit || 3,
            })
          : [];

      const parts = [];
      if (!sessionState.protocolInjected) {
        sessionState.protocolInjected = true;
        parts.push(ACTIVE_PROTOCOL);
      }
      if (hasNegativeFeedbackCue(input.prompt) && sessionState.activeAssets.length) {
        parts.push(
          `[copilot-evo feedback signal] The user expressed dissatisfaction or correction while active assets (${sessionState.activeAssets.join(", ")}) were in context. If any of those assets misled the approach, call \`evo_manage_asset({ action: "downvote", id })\` or supersede it via \`evo_solidify\`.`
        );
      }
      if (hasCorrectionOrPitfallCue(input.prompt)) {
        sessionState.pendingCorrection = { ts: Date.now() };
        parts.push(
          "[copilot-evo pitfall/correction signal] The user reported an issue, missing behavior, or correction. After resolving and verifying it, proactively load `evo_solidify` via `tool_search_tool` (if needed) and record ONE atomic local `Rule` or `Fix` if this revealed a reusable platform, tool, rendering, or repository pitfall—without waiting for the user to ask."
        );
      } else {
        sessionState.pendingCorrection = null;
      }
      if (matched.length) {
        sessionState.activeAssets = matched.map((a) => a.id);
        recordRecallEvent(matched, { trigger: "prompt", signals });
        parts.push(formatAssetsContext(matched));
      }
      if (hasStrategyCue(input.prompt)) {
        parts.push(
          "[copilot-evo rule signal] This prompt states a reusable rule, pitfall, or workflow preference. Load `evo_solidify` via `tool_search_tool` if needed, call `evo_solidify` in English with `scope: \"local\"`, show the preview, and ask the user before promoting to `team` or syncing."
        );
      }
      if (!parts.length) return;
      return { additionalContext: parts.join("\n\n") };
    },

    onPreToolUse: async (input) => {
      const { rules, config } = loadStore(evoHome);
      const argsText = typeof input.toolArgs === "string" ? input.toolArgs : JSON.stringify(input.toolArgs || "");
      for (const rule of rules) {
        const g = rule.guardrail;
        if (!g?.pattern) continue;
        if (Array.isArray(g.toolNames) && g.toolNames.length && !g.toolNames.includes(input.toolName)) continue;
        const regex = new RegExp(g.pattern, "i");
        if (!regex.test(argsText)) continue;
        if (config.strictGuardrails && g.action === "deny") {
          return {
            permissionDecision: "deny",
            permissionDecisionReason: `[copilot-evo ${rule.id}] ${g.reason || rule.summary}`,
          };
        }
        return {
          additionalContext: `[copilot-evo guardrail ${rule.id}] ${g.reason || rule.summary}`,
        };
      }
    },

    onPostToolUseFailure: async (input) => {
      const toolName = String(input.toolName || "");
      if (toolName.startsWith("evo_")) return;
      const rawError = String(input.error || "");
      if (isTrivialToolFailure(toolName, rawError)) return;

      const cleanError = sanitizePayload(rawError).slice(0, 280);
      const signals = extractSignals(cleanError, [toolName], { includePlatform: true });
      const fingerprint = `${toolName}:${signals.join(",")}`;
      const now = Date.now();
      const lastSeen = sessionState.recentFailureFingerprints.get(fingerprint) || 0;
      const isDuplicate = now - lastSeen < 10000;
      sessionState.recentFailureFingerprints.set(fingerprint, now);

      const entry = { toolName, signals, error: cleanError };
      sessionState.pendingFailure = entry;
      if (!isDuplicate) {
        sessionState.recentFailures.push(entry);
        if (sessionState.recentFailures.length > 5) sessionState.recentFailures.shift();

        appendEvent(evoHome, {
          event: "tool_failure",
          toolName,
          signals,
          project: hashProjectId(input.workingDirectory),
        });
        canvasServer.broadcastUpdate("tool_failure");
      }

      const { rules, fixes } = loadStore(evoHome);
      if (input.workingDirectory) lastWorkingDirectory = input.workingDirectory;
      const matched = selectAssets({
        signals,
        repo: detectRepoSlug(lastWorkingDirectory),
        rules,
        fixes,
        limit: 2,
      });
      if (matched.length) {
        sessionState.activeAssets = matched.map((a) => a.id);
        recordRecallEvent(matched, { trigger: "tool_failure", signals, toolName });
      }
      const hint = matched.length
        ? `${formatAssetsContext(matched)}\nOnce resolved and verified, proactively call \`evo_solidify\` with \`scope: "local"\`, show the preview, and ask before promoting to \`team\` or syncing.`
        : `[copilot-evo] Failure signals recorded (${signals.join(", ")}). Once resolved and verified, proactively call \`evo_solidify\` with \`scope: "local"\` if reusable, show the preview, and ask before promoting to \`team\` or syncing.`;
      return { additionalContext: hint };
    },

    onPostToolUse: async (input) => {
      const toolName = String(input.toolName || "");
      if (toolName === "evo_solidify" && sessionState.lastSolidifiedLocalId) {
        const localId = sessionState.lastSolidifiedLocalId;
        sessionState.lastSolidifiedLocalId = "";
        return {
          additionalContext: `[copilot-evo share confirmation required] You just saved "${localId}" with scope: "local". In this turn, present the concise preview AND immediately call \`ask_user\` asking whether to share it to the team, with choices ["Keep local (Recommended)", "Share to Team (promote & push)"].`,
        };
      }
      if (toolName.startsWith("evo_")) return;

      if (toolName === "store_memory" && Date.now() - sessionState.lastSolidifyAt > 15000) {
        return {
          additionalContext:
            "[copilot-evo] A durable rule was just saved to personal memory (`store_memory`). Now load `evo_solidify` via `tool_search_tool` (if needed), call `evo_solidify` in English with `scope: \"local\"` to record it locally, show the preview, and ask the user whether to promote to `team` and sync via `evo_sync_repo`.",
        };
      }

      if (
        sessionState.pendingCorrection &&
        Date.now() - sessionState.pendingCorrection.ts < 10 * 60 * 1000 &&
        Date.now() - sessionState.lastSolidifyAt > 10000 &&
        !/^(?:view|glob|grep|list_|get_|read_|tool_search_tool)/i.test(toolName)
      ) {
        sessionState.pendingCorrection = null;
        return {
          additionalContext: `[copilot-evo auto-capture check] You just completed \`${toolName}\` while resolving a user-reported issue or correction. If this revealed a reusable pitfall or rule (for example, GitHub/Markdown rendering quirks, API/CLI behavior, or repo conventions), proactively call \`evo_solidify\` in English with \`scope: "local"\` now instead of waiting for the user to remind you.`,
        };
      }

      if (!sessionState.pendingFailure) return;

      const isVerificationOrAction =
        toolName === sessionState.pendingFailure.toolName ||
        /^(?:powershell|bash|shell|edit|create|apply_patch)$/i.test(toolName);
      if (!isVerificationOrAction) return;

      const resolvedSignals = sessionState.pendingFailure.signals;
      sessionState.pendingFailure = null;
      sessionState.recoveries++;
      if (sessionState.activeAssets.length) {
        recordAssetOutcome(evoHome, sessionState.activeAssets, "success", "tool_recovery");
        canvasServer.broadcastUpdate("auto_outcome");
        if (getPendingScoreDeltaTotal(evoHome) >= 3) {
          syncScoreDeltasOnly(evoHome).catch(() => {});
        }
      }
      return {
        additionalContext: `[copilot-evo recovery detected] A prior failure (${resolvedSignals.join(", ")}) was followed by a successful ${toolName} run. If the fix is verified and reusable, load \`evo_solidify\` via \`tool_search_tool\` (if needed), call \`evo_solidify\` in English with \`scope: "local"\`, show the preview, and ask the user before promoting to \`team\` or syncing via \`evo_sync_repo\`.`,
      };
    },

    onSessionEnd: async (input) => {
      if (getPendingScoreDeltaTotal(evoHome) > 0) {
        await syncScoreDeltasOnly(evoHome).catch(() => {});
      }
      if (!sessionState.recentFailures.length && !sessionState.solidifiedCount) return;
      appendEvent(evoHome, {
        event: "session_summary",
        reason: input.reason,
        failuresObserved: sessionState.recentFailures.length,
        recoveriesObserved: sessionState.recoveries,
        solidifiedCount: sessionState.solidifiedCount,
        project: hashProjectId(input.workingDirectory),
      });
    },
  },

  tools: [
    {
      name: "evo_search",
      description: "Search or list local and team-synced Experiences (Rules and Fixes) by keywords, signals, kind, or scope.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords or error text (omit or empty to list)" },
          signals: { type: "array", items: { type: "string" }, description: "Signal tags such as test_failure, win32, npm_error" },
          scope: { type: "string", enum: ["", "local", "team", "starter"], description: "Optional scope filter" },
          kind: { type: "string", enum: ["", "Rule", "Fix"], description: "Optional experience kind filter" },
          repo: { type: "string", description: "Optional owner/repo filter; defaults to current workspace repo when detected" },
          limit: { type: "number", description: "Maximum results (default 5)" },
        },
      },
      handler: async (args) => {
        const { rules, fixes } = loadStore(evoHome);
        const signals = extractSignals(args.query || "", args.signals || [], { includePlatform: false });
        const repo = args.repo || detectRepoSlug(lastWorkingDirectory);
        const results = selectAssets({
          signals,
          query: args.query || "",
          scope: args.scope || "",
          kind: args.kind || "",
          repo,
          rules,
          fixes,
          limit: args.limit || 5,
        });
        if (results.length && (args.query || (args.signals && args.signals.length))) {
          recordRecallEvent(results, { trigger: "search", signals });
        }
        return JSON.stringify(
          {
            count: results.length,
            experiences: results,
            previews: results.map((asset) => formatAssetPreview(asset)),
          },
          null,
          2
        );
      },
    },
    {
      name: "evo_solidify",
      description: "Proactively record ONE atomic, focused Rule (workflow strategy) or Fix (verified bug fix) in English into the Experience store with automatic secret/path sanitization. Never bundle multiple unrelated topics into a single experience—call evo_solidify once per distinct concern (2-4 signals, 1-3 steps). Default to scope: 'local'; confirm with the user before promoting to 'team' or syncing via evo_sync_repo.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["Rule", "Fix"], description: "Experience kind: Rule (strategy/convention) or Fix (verified solution)" },
          id: { type: "string", description: "Optional kebab-case ID (updates existing if matched)" },
          title: { type: "string", description: "Short descriptive title in English" },
          summary: { type: "string", description: "Concise English explanation of the pattern or root cause" },
          signals: { type: "array", items: { type: "string" }, description: "English lowercase trigger signals (e.g. test_failure, win32, enoent)" },
          strategy: { type: "array", items: { type: "string" }, description: "Ordered actionable steps in English" },
          solution: { type: "string", description: "Concrete fix summary in English (especially for Fix experiences)" },
          validation: { type: "array", items: { type: "string" }, description: "Safe verification commands (node/npm/npx/pytest/dotnet/cargo/go test)" },
          scope: { type: "string", enum: ["local", "team"], description: "local stays on this machine; team stages sanitized experience for private repo sync" },
          repoScope: { type: "string", description: "Repository applicability: '*' for all repos (default), 'current' for the active Git repo, or 'owner/repo'" },
          ruleId: { type: "string", description: "For Fixes: ID of the Rule this fix applied" },
          parentId: { type: "string", description: "Optional ID of an earlier Rule or Fix this experience refines" },
          supersedes: { type: "string", description: "Optional ID of an outdated experience replaced by this one" },
        },
        required: ["kind", "title", "summary", "signals"],
      },
      handler: async (args) => {
        const res = solidifyAsset(
          { ...args, workingDirectory: lastWorkingDirectory || process.cwd() },
          { evoHome }
        );
        if (res.ok) {
          sessionState.solidifiedCount++;
          sessionState.lastSolidifyAt = Date.now();
          sessionState.pendingCorrection = null;
          sessionState.lastSolidifiedLocalId = "";
          if (res.asset.scope === "local") {
            let promptedInUi = false;
            try {
              if (session.capabilities?.ui?.elicitation !== false && typeof session.ui?.select === "function") {
                const msg = [
                  `Saved locally: "${res.asset.title}" (${res.asset.type} · ${res.asset.repoScope && res.asset.repoScope !== "*" ? res.asset.repoScope : "Cross-repo"})`,
                  res.asset.summary,
                  "",
                  "Share this experience with your team?",
                ].join("\n");
                const runSelect = sessionState.promptQueue.then(() =>
                  session.ui.select(msg, ["Keep local", "Share to Team"])
                );
                sessionState.promptQueue = runSelect.catch(() => null);
                const choice = await runSelect;
                promptedInUi = true;
                if (choice === "Share to Team") {
                  const promoted = manageAsset("promote_team", res.asset.id, { evoHome });
                  if (promoted.ok) {
                    res.asset = promoted.asset;
                    res.preview = formatAssetPreview(promoted.asset);
                    res.sharedToTeam = true;
                    try {
                      const pushRes = await syncRepoPush(evoHome);
                      res.pushed = Boolean(pushRes?.pushed);
                      if (!pushRes?.ok && pushRes?.error) res.syncError = pushRes.error;
                    } catch (err) {
                      res.pushed = false;
                      res.syncError = err.message;
                    }
                    res.nextAction = res.pushed
                      ? "Promoted to team and pushed to the team repository."
                      : "Promoted to team locally (Git push did not complete).";
                  } else {
                    res.sharedToTeam = false;
                    res.shareError = promoted.error;
                  }
                } else {
                  res.sharedToTeam = false;
                  res.nextAction = "Kept local per user selection.";
                }
              }
            } catch {
              promptedInUi = false;
            }
            if (!promptedInUi) {
              sessionState.lastSolidifiedLocalId = res.asset.id;
            }
          }
          canvasServer.setViewState({
            tab: res.asset.scope === "local" ? "local" : "assets",
            filter: "all",
            assetId: res.asset.id,
          });
          canvasServer.broadcastUpdate("solidify");
          try {
            await session.log(`Saved ${res.asset.type} ${res.asset.id} (${res.asset.scope})`);
          } catch {
            // Ignore log errors outside active UI timeline.
          }
        }
        return JSON.stringify(res, null, 2);
      },
    },
    {
      name: "evo_status",
      description: "Inspect copilot-evo store statistics, recent session signals, and private Git sync configuration.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const { rules, fixes, config } = loadStore(evoHome);
        const syncRepoPath = resolveSyncRepoPath(evoHome);
        return JSON.stringify(
          {
            version: EXTENSION_VERSION,
            evoHome,
            currentRepo: detectRepoSlug(lastWorkingDirectory) || null,
            counts: {
              rules: rules.length,
              fixes: fixes.length,
              teamRules: rules.filter((r) => r.scope === "team").length,
              teamFixes: fixes.filter((f) => f.scope === "team").length,
              events: countEvents(evoHome),
            },
            session: sessionState,
            syncRepoPath,
            config,
          },
          null,
          2
        );
      },
    },
    {
      name: "evo_manage_asset",
      description: "Inspect, promote, pin, vote on, or delete a local Experience (Rule or Fix) by ID.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["inspect", "promote_team", "pin", "unpin", "upvote", "downvote", "delete"],
          },
          id: { type: "string", description: "Experience ID" },
        },
        required: ["action", "id"],
      },
      handler: async (args) => {
        const res = manageAsset(args.action, args.id, { evoHome });
        if (res.ok && args.action !== "inspect") {
          canvasServer.broadcastUpdate(args.action);
          if ((args.action === "upvote" || args.action === "downvote") && getPendingScoreDeltaTotal(evoHome) >= 3) {
            syncScoreDeltasOnly(evoHome).catch(() => {});
          }
        }
        return JSON.stringify(res, null, 2);
      },
    },
    {
      name: "evo_sync_repo",
      description: "Pull or push sanitized team Experiences (Rules and Fixes) directly to the private Git repo (no PR), or export/import offline .evopack.json bundles. Auto-clones the configured repo if not present locally.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["pull", "push", "export", "import"] },
          repoPath: { type: "string", description: "Optional local clone path of the private copilot-evo repo" },
          repo: { type: "string", description: "Optional GitHub owner/repo or git URL when cloning for the first time" },
          filePath: { type: "string", description: "Bundle path for export/import actions" },
          commitMessage: { type: "string", description: "Optional commit message for push" },
        },
        required: ["action"],
      },
      handler: async (args) => {
        let res;
        if (args.action === "pull") {
          res = await syncRepoPull(evoHome, { repoPath: args.repoPath, repo: args.repo });
        } else if (args.action === "push") {
          res = await syncRepoPush(evoHome, {
            repoPath: args.repoPath,
            repo: args.repo,
            commitMessage: args.commitMessage,
          });
        } else if (args.action === "export") {
          res = exportBundle(evoHome, { scope: "team", outputPath: args.filePath });
        } else if (args.action === "import") {
          res = importBundle(evoHome, { inputPath: args.filePath });
        } else {
          res = { ok: false, error: `Unsupported action: ${args.action}` };
        }
        if (res?.ok) canvasServer.broadcastUpdate(`sync_${args.action}`);
        return JSON.stringify(res, null, 2);
      },
    },
  ],

  canvases: [
    createCanvas({
      id: "evo-dashboard",
      displayName: "Copilot Evo",
      description: "Browse, preview, search, rank, delete, and sync copilot-evo Experiences (Rules and Fixes), relationships, and events.",
      inputSchema: {
        type: "object",
        properties: {
          tab: { type: "string", enum: ["assets", "local", "contributors", "relationships", "events"] },
          filter: { type: "string", enum: ["all", "team", "local", "starter"] },
          assetId: { type: "string" },
        },
      },
      actions: [
        {
          name: "refresh",
          description: "Refresh the Copilot Evo canvas view from the local Experience store.",
          handler: async () => {
            canvasServer.broadcastUpdate("manual_refresh");
            return canvasServer.buildSnapshot().counts;
          },
        },
        {
          name: "select_asset",
          description: "Focus and preview a specific Rule or Fix by ID in the Copilot Evo canvas.",
          inputSchema: {
            type: "object",
            properties: {
              assetId: { type: "string" },
              tab: { type: "string", enum: ["assets", "local", "contributors", "relationships", "events"] },
            },
            required: ["assetId"],
          },
          handler: async (ctx) => {
            const id = ctx.input?.assetId;
            if (!id) throw new CanvasError("invalid_input", "assetId is required.");
            return canvasServer.setViewState({
              tab: ctx.input?.tab || "assets",
              assetId: id,
            });
          },
        },
      ],
      open: (ctx) => canvasServer.openInstance(ctx),
      onClose: (ctx) => canvasServer.closeInstance(ctx),
    }),
  ],
});

activeSession = session;
