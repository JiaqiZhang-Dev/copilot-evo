import { joinSession } from "@github/copilot-sdk/extension";
import { sanitizePayload } from "./sanitize.mjs";
import {
  appendEvent,
  countEvents,
  exportBundle,
  extractSignals,
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
const sessionState = {
  recentFailures: [],
  recoveries: 0,
  solidifiedCount: 0,
};

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
      const signals = extractSignals(input.initialPrompt || "");
      const matched = selectAssets({
        signals,
        genes,
        capsules,
        limit: config.autoInjectLimit || 3,
      });
      if (!matched.length) return;
      return { additionalContext: formatAssetsContext(matched) };
    },

    onUserPromptSubmitted: async (input) => {
      const { genes, capsules, config } = loadStore(evoHome);
      const failureSignals = sessionState.recentFailures.flatMap((f) => f.signals);
      const signals = extractSignals(input.prompt, failureSignals);
      const matched = selectAssets({
        signals,
        query: input.prompt,
        genes,
        capsules,
        limit: config.autoInjectLimit || 3,
      });
      if (!matched.length) return;
      return { additionalContext: formatAssetsContext(matched) };
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
      const cleanError = sanitizePayload(String(input.error || "")).slice(0, 280);
      const signals = extractSignals(cleanError, [input.toolName]);
      sessionState.recentFailures.push({ toolName: input.toolName, signals, error: cleanError });
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
        ? `${formatAssetsContext(matched)}\nOnce resolved and verified, you can call evo_solidify to save the fix.`
        : `[copilot-evo] Failure signals recorded (${signals.join(", ")}). Once resolved and verified, call evo_solidify if the fix is reusable.`;
      return { additionalContext: hint };
    },

    onPostToolUse: async (input) => {
      if (!sessionState.recentFailures.length) return;
      const last = sessionState.recentFailures[sessionState.recentFailures.length - 1];
      if (last.toolName === input.toolName) {
        sessionState.recoveries++;
      }
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
        const signals = extractSignals(args.query || "", args.signals || []);
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
      description: "Record a verified strategy (Gene) or fix recipe (Capsule) into the GEP store with automatic secret/path sanitization.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["Gene", "Capsule"], description: "Asset type" },
          id: { type: "string", description: "Optional kebab-case ID (updates existing if matched)" },
          title: { type: "string", description: "Short descriptive title" },
          summary: { type: "string", description: "Concise explanation of the pattern or root cause" },
          signals: { type: "array", items: { type: "string" }, description: "Trigger signals (e.g. test_failure, win32, enoent)" },
          strategy: { type: "array", items: { type: "string" }, description: "Ordered actionable steps" },
          solution: { type: "string", description: "Concrete fix summary (especially for Capsules)" },
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
      description: "Pull or push sanitized team Genes/Capsules directly to the private Git repo (no PR), or export/import offline .evopack.json bundles.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["pull", "push", "export", "import"] },
          repoPath: { type: "string", description: "Optional local clone path of JiaqiZhang-Dev/copilot-evo" },
          filePath: { type: "string", description: "Bundle path for export/import actions" },
          commitMessage: { type: "string", description: "Optional commit message for push" },
          autoPromote: { type: "boolean", description: "Promote imported assets immediately (default true for pull, false for bundle import)" },
        },
        required: ["action"],
      },
      handler: async (args) => {
        if (args.action === "pull") {
          return JSON.stringify(
            await syncRepoPull(evoHome, { repoPath: args.repoPath, autoPromote: args.autoPromote ?? true }),
            null,
            2
          );
        }
        if (args.action === "push") {
          return JSON.stringify(
            await syncRepoPush(evoHome, { repoPath: args.repoPath, commitMessage: args.commitMessage }),
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
