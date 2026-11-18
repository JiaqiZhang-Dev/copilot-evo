# copilot-evo

Self-evolving **Experience (`EXP`: Rules & Fixes)** memory and team sharing plugin for GitHub Copilot App and CLI.

## Capabilities

- **Proactive Auto-Evolution**: Injects an active protocol on session start, detects failure-to-recovery transitions and rule cues, records verified `Rule` and `Fix` experiences via `evo_solidify`, displays a preview, and prompts to sync via `evo_sync_repo`.
- **Repo Scope, Auto-Scoring & Lineage**: Supports global (`*`) or repository-scoped (`owner/repo`) experiences, automatic scoring across Quality, Reliability, Lineage, and Freshness, and `geneId` / `parentId` / `supersedes` relationships.
- **In-Chat & Canvas Preview**: Preview stored experiences in chat with `/evo-list`, or open the **Copilot Evo Canvas** (`/evo-canvas`) with **Experiences**, **Leaderboard**, **Relationships**, and **Events** views plus one-click team sharing and **Pull Team** sync.
- **Local-First Storage**: Keeps raw session failure logs and unshared experiences on your machine under `~/.copilot/evo/` (overridable with `COPILOT_EVO_HOME`).
- **Privacy & Leak Guardrails**: Strips tokens, private keys, database credentials, internal IPs, emails, and personal home-directory paths, and checks secret environment variables before saving team experiences or syncing to Git.
- **Private Git Sync**: New sessions pull shared team experiences and scores in the background, and score deltas on existing team experiences sync automatically without uploading unconfirmed local rules or fixes. New experiences always stay local until you review the preview and confirm sharing.

## Install as a Copilot Plugin

```bash
copilot plugin install JiaqiZhang-Dev/copilot-evo
```

To pull the latest plugin updates and shared experiences:

```bash
copilot plugin update copilot-evo
```

## Syncing Shared Experiences via Your Private Repo

1. After Copilot verifies a reusable rule or fix, it runs `evo_solidify` and asks whether to sync via `evo_sync_repo`.
2. When you confirm sync, `evo_sync_repo` (`action: "push"`) pulls/rebases the latest `main` in `~/.copilot/evo/sync-repo` (or `~/copilot-evo` / `COPILOT_EVO_SYNC_REPO`), runs leak checks, merges score deltas, and pushes to `assets/gep/team-genes.json` and `assets/gep/team-capsules.json`.
3. Teammates can run `evo_sync_repo` (`action: "pull"`) or click **Pull** in the Canvas to receive shared experiences and scores.

## Development & Tests

```bash
npm test
```
