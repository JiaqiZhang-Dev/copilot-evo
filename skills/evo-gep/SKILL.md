---
name: evo-gep
description: Use the Genome Evolution Protocol (GEP) with copilot-evo to proactively discover reusable fixes and strategies, automatically call evo_solidify, and prompt the user to sync via evo_sync_repo.
metadata:
  version: "0.2.2"
---

# Copilot Evo (GEP Self-Evolution)

Use `copilot-evo` to automatically turn hard-won debugging insights, recurring fixes, and cross-project workflow rules into reusable **Genes** (reusable strategies) and **Capsules** (verified fix recipes).

## Proactive Workflow

1. **Recall first (`evo_search`)**: Check local and team-synced Genes/Capsules when hitting an unfamiliar failure or starting a recurring task.
2. **Auto-solidify in English (`evo_solidify`)**: Whenever you resolve and verify a non-obvious failure (or the user establishes a reusable cross-project rule/strategy), proactively call `evo_solidify` without waiting to be asked. Always write `title`, `summary`, `signals`, `strategy`, and `solution` in clear English (translate non-English conversations). Use `scope: "team"` for generalizable, secret-free assets and `scope: "local"` for machine-specific ones. Skip trivial one-off typos.
3. **Prompt to sync (`evo_sync_repo`)**: Immediately after `evo_solidify` succeeds for a shareable asset, ask the user (using `ask_user` when available) whether they want to push it to the team repository via `evo_sync_repo({ action: "push" })`.
4. **Manage & inspect (`evo_status`, `evo_manage_asset`)**: Inspect store stats, review imported candidates, or delete outdated local entries.

## Privacy & Safety Rules

1. Keep raw session logs and unverified notes local (`scope: "local"`). Only mark generalizable, secret-free assets as `scope: "team"`.
2. Never include real tokens, passwords, internal hostnames/IPs, emails, or personal home-directory paths in any Gene or Capsule. Use placeholders such as `<repo-root>` or `process.env.TOKEN_NAME`.
3. Every `team`-scoped write and `evo_sync_repo` push automatically runs pattern redaction and `process.env` reverse leak detection; if a leak is detected, fix the payload before retrying.
