---
name: copilot-evo
description: Use copilot-evo to proactively discover reusable Knowledge, Rules, and Fixes, automatically call evo_solidify, and prompt the user before sharing to the team repository.
metadata:
  version: "0.11.0"
---

# Copilot Evo (Self-Evolving Experiences)

Use `copilot-evo` to turn debugging insights, verified bug fixes (`Fix`), domain/architecture facts (`Knowledge`), and cross-project workflow conventions (`Rule`) into reusable experiences.

## Proactive Workflow

1. **Recall first (`evo_search`)**: Check local and team-synced experiences when hitting an unfamiliar failure or starting a recurring task. Recall respects `repoScope` (`*` for global, `owner/repo` for repo-specific items) and ranks items by score.
2. **Auto-solidify atomically locally in English (`evo_solidify`)**: Proactively call `evo_solidify` with `scope: "local"` without waiting to be asked. Choose the matching category:
   - `kind: "Knowledge"`: Domain, architecture, service-coupling, or platform quirks (e.g., how a runtime or CI trigger behaves).
   - `kind: "Rule"`: Actionable conventions, review checklists, and step-by-step workflows.
   - `kind: "Fix"`: Verified troubleshooting and concrete bug fixes after resolving a non-obvious failure.
   Keep each experience **atomic** (one focused topic, 2-4 signals, 1-3 concise takeaways/steps)—split distinct concerns into separate `evo_solidify` calls instead of bundling them into one mega-entry. Attach verified public `https://` `references` (PR, issue, commit, or official docs URLs) as evidence when available. Always write `title`, `summary`, `signals`, `strategy`, and `solution` in clear English (translate non-English conversations). Set `repoScope: "current"` when it applies only to the active repository, and link `ruleId` / `parentId` / `supersedes` when extending or replacing an earlier experience. Skip trivial one-off typos.
3. **Preview & ask via `ask_user` before sharing to team (`evo_manage_asset`, `evo_sync_repo`)**: Immediately after `evo_solidify` succeeds with `scope: "local"`, show the concise English preview (`id`, `repoScope`, `title`, `summary`, `signals`, `strategy`/`solution`) to the user, then MUST call `ask_user` with choices `["Keep local", "Share with team", "Refine this experience"]` if native UI selection did not already run. Only call `evo_manage_asset({ action: "promote_team", id })` and `evo_sync_repo({ action: "push" })` after explicit user confirmation. Never assign `scope: "team"` without explicit user confirmation.
4. **Explicit attribution & proactive quality audit**:
   - Only call `evo_manage_asset({ action: "upvote", id })` for recalled experiences that genuinely helped solve or guide the task, and `downvote` any that were misleading.
   - When a recalled experience is wrong, unhelpful, or has an overly broad/misleading `kind`, `signals`, or `repoScope`, proactively flag it to the user with a concise comparison (current `id`, `kind`, `repoScope`, `signals`, `summary` vs. proposed change or deletion reason) and call `ask_user` with choices `["Update experience", "Delete experience", "Downvote only", "Keep as-is"]`.
   - On confirmation, run `evo_solidify` (passing the same `id` to update in place, or `supersedes`) or `evo_manage_asset({ action: "delete" | "downvote", id })`. If a `team`-scoped experience was updated or deleted, prompt/confirm before pushing via `evo_sync_repo({ action: "push" })`.
5. **Browse & manage (`/evo-list`, `/evo-canvas`, `evo_status`, `evo_manage_asset`)**: Use `/evo-list` for an in-chat preview, `/evo-canvas` (or `open_canvas` with `canvasId: "evo-dashboard"`) for the side-panel dashboard (**Experiences**, **Local**, **Relationships**, **Events**), and `evo_manage_asset` to inspect or delete entries.

## Privacy & Safety Rules

1. Keep raw session logs and unverified notes local (`scope: "local"`). Only mark generalizable, secret-free experiences as `scope: "team"`.
2. Never include real tokens, passwords, internal hostnames/IPs, emails, or personal home-directory paths in any experience. Use placeholders such as `<repo-root>` or `process.env.TOKEN_NAME`.
3. Every `team`-scoped write and `evo_sync_repo` push automatically runs pattern redaction and secret environment variable leak detection; if a leak is detected, fix the payload before retrying.
