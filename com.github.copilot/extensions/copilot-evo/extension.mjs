import { joinSession } from "@github/copilot-sdk/extension";
import { sanitizePayload } from "./sanitize.mjs";
import {
  appendEvent,
  countEvents,
  exportBundle,
  extractSignals,
  hasStrategyCue,
  hashProjectId,
  importBundle,
  initStore,
  loadStore,
  manageAsset,
  resolveSyncRepoPath,
  selectAssets,
  solidifyAsset,
  syncRepoPull,
  syncRepoPush,
} from "./store.mjs";

const evoHome = initStore();
const EXTENSION_VERSION = "0.2.2";
const sessionState = {
  protocolInjected: false,
  pendingFailure: null,
  lastSolidifyAt: 0,
  recentFailures: [],
  recoveries: 0,
  solidifiedCount: 0,
};

const ACTIVE_PROTOCOL = [
  "[copilot-evo active protocol]",
  "1. Extension tools (`evo_solidify`, `evo_sync_repo`, `evo_search`, `evo_status`, `evo_manage_asset`) may be deferred; load them with `tool_search_tool` whenever needed.",
  "2. Auto-discover & solidify (English only): When you resolve and verify a non-obvious error/failure, or when the user states a reusable cross-project rule/preference (even if also saved via `store_memory`), proactively call `evo_solidify` without waiting to be asked (skip trivial typos). Write ALL solidified fields (`title`, `summary`, `signals`, `strategy`, `solution`) in concise English, translating if the conversation is in another language. Use `scope: \"team\"` when generalizable and free of secrets/paths, otherwise `scope: \"local\"`.",
  "3. Auto-ask before sync: Immediately after `evo_solidify` succeeds for a shareable asset, proactively ask the user (using `ask_user` when available) whether to sync it to the team repository via `evo_sync_repo({ action: \"push\" })`.",
].join("\n");

function formatAssetsContext(assets) {
  if (!assets.length) return "";
  const lines = assets.map((a) => {
    const steps = a.strategy?.length ? ` Steps: ${a.strategy.slice(0, 3).join(" -> ")}` : "";
    const fix = a.solution ? ` Fix: ${a.solution}` : "";
    return `- [${a.type}:${a.id}] ${a.title}: ${a.summary}${fix}${steps}`;
  });
  return `[copilot-evo GEP guidance]\n${lines.join("\n")}`;
}

const session = await joinSession({
  hooks: {
    onSessionStart: async (input) => {
      initStore({ evoHome });
      const { genes, capsules, config } = loadStore(evoHome);
      const signals = extractSignals(input.initialPrompt || "", [], { includePlatform: false });
      const matched = signals.length
        ? selectAssets({ signals, genes, capsules, limit: config.autoInjectLimit || 3 })
        : [];
      sessionState.protocolInjected = true;
      const parts = [ACTIVE_PROTOCOL];
      if (matched.length) parts.push(formatAssetsContext(matched));
      return { additionalContext: parts.join("\n\n") };
    },

    onUserPromptSubmitted: async (input) => {
      const { genes, capsules, config } = loadStore(evoHome);
      const failureSignals = sessionState.recentFailures.flatMap((f) => f.signals);
      const signals = extractSignals(input.prompt, failureSignals, { includePlatform: false });
      const matched =
        signals.length || hasStrategyCue(input.prompt)
          ? selectAssets({
              signals,
              query: input.prompt,
              genes,
              capsules,
              limit: config.autoInjectLimit || 3,
            })
          : [];

      const parts = [];
      if (!sessionState.protocolInjected) {
        sessionState.protocolInjected = true;
        parts.push(ACTIVE_PROTOCOL);
      }
      if (matched.length) {
        parts.push(formatAssetsContext(matched));
      }
      if (hasStrategyCue(input.prompt)) {
        parts.push(
          "[copilot-evo rule signal] This prompt states a reusable rule, pitfall, or workflow preference. Load `evo_solidify` and `evo_sync_repo` via `tool_search_tool` if needed, call `evo_solidify` in English (in addition to `store_memory` if used) to persist it as a Gene, then ask the user whether to sync via `evo_sync_repo`."
        );
      }
      if (!parts.length) return;
      return { additionalContext: parts.join("\n\n") };
    },

    onPreToolUse: async (input) => {
      const { genes, config } = loadStore(evoHome);
      const argsText = typeof input.toolArgs === "string" ? input.toolArgs : JSON.stringify(input.toolArgs || "");
      for (const gene of genes) {
        const g = gene.guardrail;
        if (!g?.pattern) continue;
        if (Array.isArray(g.toolNames) && g.toolNames.length && !g.toolNames.includes(input.toolName)) continue;
        const regex = new RegExp(g.pattern, "i");
        if (!regex.test(argsText)) continue;
        if (config.strictGuardrails && g.action === "deny") {
          return {
            permissionDecision: "deny",
            permissionDecisionReason: `[copilot-evo ${gene.id}] ${g.reason || gene.summary}`,
          };
        }
        return {
          additionalContext: `[copilot-evo guardrail ${gene.id}] ${g.reason || gene.summary}`,
        };
      }
    },

    onPostToolUseFailure: async (input) => {
      if (String(input.toolName || "").startsWith("evo_")) return;
      const cleanError = sanitizePayload(String(input.error || "")).slice(0, 280);
      const signals = extractSignals(cleanError, [input.toolName], { includePlatform: true });
      const entry = { toolName: input.toolName, signals, error: cleanError };
      sessionState.pendingFailure = entry;
      sessionState.recentFailures.push(entry);
      if (sessionState.recentFailures.length > 5) sessionState.recentFailures.shift();

      appendEvent(evoHome, {
        event: "tool_failure",
        toolName: input.toolName,
        signals,
        project: hashProjectId(input.workingDirectory),
      });

      const { genes, capsules } = loadStore(evoHome);
      const matched = selectAssets({ signals, genes, capsules, limit: 2 });
      const hint = matched.length
        ? `${formatAssetsContext(matched)}\nOnce resolved and verified, proactively call \`evo_solidify\` and ask whether to sync via \`evo_sync_repo\`.`
        : `[copilot-evo] Failure signals recorded (${signals.join(", ")}). Once resolved and verified, proactively call \`evo_solidify\` if the fix is reusable, then ask whether to sync via \`evo_sync_repo\`.`;
      return { additionalContext: hint };
    },

    onPostToolUse: async (input) => {
      const toolName = String(input.toolName || "");
      if (toolName.startsWith("evo_")) return;

      if (toolName === "store_memory" && Date.now() - sessionState.lastSolidifyAt > 15000) {
        return {
          additionalContext:
            "[copilot-evo] A durable rule was just saved to personal memory (`store_memory`). Now load `evo_solidify` and `evo_sync_repo` via `tool_search_tool` (if not already loaded), call `evo_solidify` in English to also record this rule as a GEP Gene (use `scope: \"team\"` if generalizable and secret-free), and then ask the user whether to sync it to the team repo via `evo_sync_repo({ action: \"push\" })`.",
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
      return {
        additionalContext: `[copilot-evo recovery detected] A prior failure (${resolvedSignals.join(", ")}) was followed by a successful ${toolName} run. If the fix is verified and reusable across tasks/projects, load \`evo_solidify\` and \`evo_sync_repo\` via \`tool_search_tool\` (if needed), call \`evo_solidify\` now (use \`scope: "team"\` when generalizable and secret-free), then ask the user whether to sync via \`evo_sync_repo\`.`,
      };
    },

    onSessionEnd: async (input) => {
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
      description: "Search local and team-synced GEP Genes and Capsules by keywords, signals, or scope.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords or error text" },
          signals: { type: "array", items: { type: "string" }, description: "Signal tags such as test_failure, win32, npm_error" },
          scope: { type: "string", enum: ["", "local", "team", "starter"], description: "Optional scope filter" },
          limit: { type: "number", description: "Maximum results (default 5)" },
        },
      },
      handler: async (args) => {
        const { genes, capsules } = loadStore(evoHome);
        const signals = extractSignals(args.query || "", args.signals || [], { includePlatform: false });
        const results = selectAssets({
          signals,
          query: args.query || "",
          scope: args.scope || "",
          genes,
          capsules,
          limit: args.limit || 5,
        });
        return JSON.stringify({ count: results.length, assets: results }, null, 2);
      },
    },
    {
      name: "evo_solidify",
      description: "Proactively record a verified reusable strategy (Gene) or fix recipe (Capsule) in English into the GEP store with automatic secret/path sanitization. Call automatically after resolving reusable failures or learning generalizable strategies, then ask the user whether to sync via evo_sync_repo.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["Gene", "Capsule"], description: "Asset type" },
          id: { type: "string", description: "Optional kebab-case ID (updates existing if matched)" },
          title: { type: "string", description: "Short descriptive title in English" },
          summary: { type: "string", description: "Concise English explanation of the pattern or root cause" },
          signals: { type: "array", items: { type: "string" }, description: "English lowercase trigger signals (e.g. test_failure, win32, enoent)" },
          strategy: { type: "array", items: { type: "string" }, description: "Ordered actionable steps in English" },
          solution: { type: "string", description: "Concrete fix summary in English (especially for Capsules)" },
          validation: { type: "array", items: { type: "string" }, description: "Safe verification commands (node/npm/npx/pytest/dotnet/cargo/go test)" },
          scope: { type: "string", enum: ["local", "team"], description: "local stays on this machine; team stages sanitized asset for private repo sync" },
        },
        required: ["kind", "title", "summary", "signals"],
      },
      handler: async (args) => {
        const res = solidifyAsset(
          { ...args, workingDirectory: process.cwd() },
          { evoHome }
        );
        if (res.ok) {
          sessionState.solidifiedCount++;
          sessionState.lastSolidifyAt = Date.now();
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
        const { genes, capsules, candidates, config } = loadStore(evoHome);
        const syncRepoPath = resolveSyncRepoPath(evoHome);
        return JSON.stringify(
          {
            version: EXTENSION_VERSION,
            evoHome,
            counts: {
              genes: genes.length,
              capsules: capsules.length,
              teamGenes: genes.filter((g) => g.scope === "team").length,
              teamCapsules: capsules.filter((c) => c.scope === "team").length,
              candidates: candidates.length,
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
      description: "Inspect, promote from candidates, or delete a local Gene/Capsule by ID.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["inspect", "promote", "delete", "list_candidates"] },
          id: { type: "string", description: "Asset ID (required except for list_candidates)" },
        },
        required: ["action"],
      },
      handler: async (args) => {
        return JSON.stringify(manageAsset(args.action, args.id, { evoHome }), null, 2);
      },
    },
    {
      name: "evo_sync_repo",
      description: "Pull or push sanitized team Genes/Capsules directly to the private Git repo (no PR), or export/import offline .evopack.json bundles. Auto-clones the configured repo if not present locally.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["pull", "push", "export", "import"] },
          repoPath: { type: "string", description: "Optional local clone path of the private copilot-evo repo" },
          repo: { type: "string", description: "Optional GitHub owner/repo or git URL when cloning for the first time" },
          filePath: { type: "string", description: "Bundle path for export/import actions" },
          commitMessage: { type: "string", description: "Optional commit message for push" },
          autoPromote: { type: "boolean", description: "Promote imported assets immediately (default true for pull, false for bundle import)" },
        },
        required: ["action"],
      },
      handler: async (args) => {
        if (args.action === "pull") {
          return JSON.stringify(
            await syncRepoPull(evoHome, {
              repoPath: args.repoPath,
              repo: args.repo,
              autoPromote: args.autoPromote ?? true,
            }),
            null,
            2
          );
        }
        if (args.action === "push") {
          return JSON.stringify(
            await syncRepoPush(evoHome, {
              repoPath: args.repoPath,
              repo: args.repo,
              commitMessage: args.commitMessage,
            }),
            null,
            2
          );
        }
        if (args.action === "export") {
          return JSON.stringify(exportBundle(evoHome, { scope: "team", outputPath: args.filePath }), null, 2);
        }
        if (args.action === "import") {
          return JSON.stringify(
            importBundle(evoHome, { inputPath: args.filePath, autoPromote: args.autoPromote ?? false }),
            null,
            2
          );
        }
        return JSON.stringify({ ok: false, error: `Unsupported action: ${args.action}` });
      },
    },
  ],
});
