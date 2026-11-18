# copilot-evo

Self-evolving GEP (Genes, Capsules, EvolutionEvents) memory and cross-project experience sharing plugin for GitHub Copilot App and CLI.

## Capabilities

- **Automatic Signal Capture & Recall**: Uses Copilot SDK lifecycle hooks (`onSessionStart`, `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUseFailure`, `onPostToolUse`, `onSessionEnd`) to match past strategies (Genes) and verified fixes (Capsules) to your current task.
- **Local-First Storage**: Keeps raw session failure logs and unshared assets strictly on your machine under `~/.copilot/evo/` (overridable with `COPILOT_EVO_HOME`).
- **Pre-Share Privacy & Leak Guardrails**: Automatically strips tokens, private keys, database credentials, internal IPs, emails, and personal home-directory paths, and checks `process.env` secrets before saving `team`-scoped assets or syncing to Git.
- **Private Git Sync (No PR Required)**: Push sanitized `team` Genes and Capsules directly to `main` via `evo_sync_repo`, or export/import offline `.evopack.json` bundles.

## Install as a Copilot Plugin

```bash
copilot plugin install JiaqiZhang-Dev/copilot-evo
```

To update later after new team Genes/Capsules are pushed:

```bash
copilot plugin update copilot-evo
```

## Syncing Shared Experiences via Your Private Repo

1. Clone your private plugin repo locally (default lookup path is `~/copilot-evo`, or set `COPILOT_EVO_SYNC_REPO`).
2. Save a verified fix with `evo_solidify` using `scope: "team"`.
3. Ask Copilot to run `evo_sync_repo` with `action: "push"` to sanitize, commit, and push directly to `assets/gep/team-genes.json` and `assets/gep/team-capsules.json`.
4. On another machine, run `evo_sync_repo` with `action: "pull"` or `copilot plugin update copilot-evo` to receive the shared assets.

## Development & Tests

```bash
npm test
```
