# Privacy, Sanitization, and Team Sync

`copilot-evo` is built local-first so raw session errors, local filesystem paths, and credentials never leave your machine automatically.

## Storage Layout

All runtime data lives locally under `~/.copilot/evo/` (or `$COPILOT_EVO_HOME`):

| File | Purpose | Shared with Team? |
| --- | --- | --- |
| `rules.json` | Local, starter, and pulled team `Rule` entries | Only `scope: "team"` items sync |
| `fixes.json` | Local and pulled team `Fix` entries | Only `scope: "team"` items sync |
| `events.jsonl` | Sanitized local audit log of tool failures, recoveries, solidifications, and syncs | Never shared |
| `config.json` | Sync repository path/slug, guardrail mode, and last auto-pull timestamp | Never shared |
| `sync-repo/` | Local Git clone used for background pulls and explicit team pushes | Synced via Git |

## Consent Boundary

1. **Local by default**: Automatic captures and `evo_solidify` calls default to `scope: "local"`.
2. **Explicit share confirmation**: When an experience is saved locally, `evo_solidify` prompts through `session.ui.select` (falling back to `ask_user` on hosts without elicitation) before promoting to `scope: "team"` or pushing to Git.
3. **Background score-delta sync**: Only numeric `pendingSuccessDelta` / `pendingFailureDelta` counters on already-shared `team` experiences sync automatically; unshared `local` experiences are never uploaded by score sync.

## Redaction & Leak Detection (`sanitize.mjs`)

Every payload written to `events.jsonl`, promoted to `team`, exported to a bundle, or pushed via Git passes through multi-stage sanitization:

- **Pattern Redaction (`redactString`)**: Masks Bearer tokens, OpenAI/Anthropic keys, GitHub PATs (`ghp_`, `gho_`, `github_pat_`), AWS access keys, npm/Slack tokens, JWTs, Azure connection secrets, private key blocks, URL basic-auth credentials, user home paths (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`), email addresses (preserving `noreply@` / `@users.noreply.github.com`), and `.env*` file references.
- **Active Leak Scanning (`fullLeakCheck`)**: Blocks `promote_team`, `exportBundle`, and `syncRepoPush` if any literal secret pattern, internal RFC-1918 IP address (`10.x`, `172.16-31.x`, `192.168.x`), or live secret environment variable value is detected. Non-secret toolchain variables (`npm_*`, `GIT_CONFIG_*`, `VSCODE_*`, `COPILOT_*`, `ELECTRON_*`) are excluded to prevent false positives, while secret-named or high-entropy opaque env values remain strictly guarded.
- **Validation Command Whitelist (`isValidationCommandAllowed`)**: Permits only safe verification commands (`node`, `npm`, `npx`, `pytest`, `python`, `dotnet`, `cargo`, `go`) without shell chaining or command substitution (`&&`, `||`, `;`, `|`, `` ` ``, `$()`, redirects).

## Team Sync & Access Control

By default, `copilot-evo` syncs `assets/experiences/team-rules.json` and `assets/experiences/team-fixes.json` directly on `main` (no pull-request overhead) using `git pull --rebase --autostash` and numeric delta merging.

### Repository Access Options

1. **Shared Private Plugin Repo**: Grant teammates **Read** access to install/pull shared experiences and **Write** access to share new experiences or sync score deltas.
2. **Dedicated Team Data Repo**: Keep the plugin repository separate and configure each developer's private team store via `COPILOT_EVO_SYNC_REPO` (local clone path) or `config.json` (`syncRepo` / `syncRepoPath`).
3. **Offline Bundle Exchange**: Use `evo_sync_repo` with `action: "export"` and `action: "import"` to exchange sanitized `.evopack.json` bundles without Git remote access.
