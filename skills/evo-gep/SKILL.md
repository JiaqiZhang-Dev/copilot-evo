---
name: evo-gep
description: Use copilot-evo to proactively discover reusable fixes and rules, automatically call evo_solidify, and prompt the user to sync via evo_sync_repo.
metadata:
  version: "0.6.0"
---

# Copilot Evo (Self-Evolving Experiences)

Use `copilot-evo` to turn debugging insights, verified bug fixes (`Fix`), and cross-project workflow conventions (`Rule`) into reusable experiences.

## Proactive Workflow

1. **Recall first (`evo_search`)**: Check local and team-synced experiences when hitting an unfamiliar failure or starting a recurring task. Recall respects `repoScope` (`*` for global, `owner/repo` for repo-specific rules) and ranks items by score.
2. **Auto-solidify in English (`evo_solidify`)**: Whenever you resolve and verify a non-obvious failure (`kind: "Fix"`) or the user establishes a reusable cross-project rule (`kind: "Rule"`), proactively call `evo_solidify` without waiting to be asked. Always write `title`, `summary`, `signals`, `strategy`, and `solution` in clear English (translate non-English conversations). Use `scope: "team"` for generalizable, secret-free experiences and `scope: "local"` for machine-specific ones; set `repoScope: "current"` when a rule applies only to the active repository, and link `geneId` / `parentId` / `supersedes` when extending or replacing an earlier experience. Skip trivial one-off typos.
3. **Preview & prompt to sync (`evo_sync_repo`)**: Immediately after `evo_solidify` succeeds for a shareable experience, show the full English preview (`id`, `scope`, `repoScope`, `title`, `summary`, `signals`, `strategy`/`solution`) to the user, then ask (using `ask_user` when available) whether to push it to the team repository via `evo_sync_repo({ action: "push" })`.
4. **Browse & manage (`/evo-list`, `/evo-canvas`, `evo_status`, `evo_manage_asset`)**: Use `/evo-list` for an in-chat preview, `/evo-canvas` (or `open_canvas` with `canvasId: "evo-dashboard"`) for the side-panel dashboard (**Experiences**, **Leaderboard**, **Relationships**, **Events**), and `evo_manage_asset` to inspect or delete entries.

## Privacy & Safety Rules

1. Keep raw session logs and unverified notes local (`scope: "local"`). Only mark generalizable, secret-free experiences as `scope: "team"`.
2. Never include real tokens, passwords, internal hostnames/IPs, emails, or personal home-directory paths in any experience. Use placeholders such as `<repo-root>` or `process.env.TOKEN_NAME`.
3. Every `team`-scoped write and `evo_sync_repo` push automatically runs pattern redaction and secret environment variable leak detection; if a leak is detected, fix the payload before retrying.
