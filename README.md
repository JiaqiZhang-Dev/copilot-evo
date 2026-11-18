# copilot-evo

Self-evolving GEP (Genes, Capsules, EvolutionEvents) memory and cross-project experience sharing plugin for GitHub Copilot App and CLI.

## Capabilities

- **Proactive Auto-Evolution**: Injects an active GEP protocol on session start, detects failure-to-recovery transitions via `onPostToolUseFailure` / `onPostToolUse` and rule cues in prompts, nudging the agent to automatically call `evo_solidify` in English, show a full preview, and ask whether to sync via `evo_sync_repo`.
- **Repo Scope, GDI Rank & Lineage**: Supports global (`*`) or repository-scoped (`owner/repo`) assets, lightweight GDI ranking (relevance, reuse hits, validation, freshness, pin/vote feedback), and `geneId` / `parentId` / `supersedes` relationships.
- **In-Chat & Canvas Preview (with GEP Arena)**: Preview stored Genes/Capsules in chat with `/evo-list`, or open the interactive **Copilot Evo Canvas** (`/evo-canvas`) to search, filter by repo/scope/type, inspect **Relationships**, compete & benchmark in the 4-dimension **Arena** leaderboard, view evolution events, and trigger Pull/Push sync.
- **Local-First Storage**: Keeps raw session failure logs and unshared assets strictly on your machine under `~/.copilot/evo/` (overridable with `COPILOT_EVO_HOME`).
- **Pre-Share Privacy & Leak Guardrails**: Automatically strips tokens, private keys, database credentials, internal IPs, emails, and personal home-directory paths, and checks `process.env` secrets before saving `team`-scoped assets or syncing to Git.
- **Private Git Sync (No PR Required)**: Push sanitized `team` Genes and Capsules directly to `main` via `evo_sync_repo` (auto-clones the configured private repo into `~/.copilot/evo/sync-repo` on first sync if needed), or export/import offline `.evopack.json` bundles.

## Install as a Copilot Plugin

```bash
copilot plugin install JiaqiZhang-Dev/copilot-evo
```

To update later after new team Genes/Capsules are pushed:

```bash
copilot plugin update copilot-evo
```

## Syncing Shared Experiences via Your Private Repo

1. After Copilot verifies a reusable fix or rule, it proactively runs `evo_solidify` and asks whether to sync via `evo_sync_repo`.
2. When you confirm sync, `evo_sync_repo` (`action: "push"`) pulls/rebases the latest `main` in `~/.copilot/evo/sync-repo` (or `~/copilot-evo` / `COPILOT_EVO_SYNC_REPO`), runs full leak checks, and pushes directly to `assets/gep/team-genes.json` and `assets/gep/team-capsules.json`.
3. Teammates can run `evo_sync_repo` (`action: "pull"`) or `copilot plugin update copilot-evo` to receive the shared assets.

## Development & Tests

```bash
npm test
```
