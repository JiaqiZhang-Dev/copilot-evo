---
name: evo-gep
description: Use the Genome Evolution Protocol (GEP) with copilot-evo to recall past strategies (Genes), solidify verified fixes (Capsules), and share sanitized experience via your private Git repository.
metadata:
  version: "0.1.0"
---

# Copilot Evo (GEP Self-Evolution)

Use `copilot-evo` to turn hard-won debugging insights, recurring fixes, and workflow preferences into reusable **Genes** (reusable strategies) and **Capsules** (verified fix recipes) stored locally and optionally synced to your private plugin Git repository.

## When to Use Each Tool

- **`evo_search`**: Search local and synced Genes/Capsules whenever you hit an unfamiliar error, start a recurring task, or want to check whether a solution already exists.
- **`evo_solidify`**: After fixing a non-obvious bug or discovering a reusable workflow rule, record it as a `Gene` or `Capsule`. Only solidify after verification succeeds; avoid recording trivial one-off typos or raw task logs.
- **`evo_status`**: Inspect local asset counts, recent session signals, and configured private sync repository settings.
- **`evo_manage_asset`**: Promote candidate assets imported from external bundles, inspect asset details, or remove outdated local entries.
- **`evo_sync_repo`**: Pull shared assets from your private Git repository or push sanitized `team`-scoped assets directly to `main` (no PR required). Also supports offline `.evopack.json` export/import.

## Privacy & Safety Rules

1. Keep raw session logs and unverified notes local (`scope: "local"`). Only mark generalizable, secret-free assets as `scope: "team"`.
2. Never include real tokens, passwords, internal hostnames/IPs, emails, or personal home-directory paths in any Gene or Capsule. Use placeholders such as `<repo-root>` or `process.env.TOKEN_NAME`.
3. Every `team`-scoped write and `evo_sync_repo` push automatically runs pattern redaction and `process.env` reverse leak detection; if a leak is detected, fix the payload before retrying.
