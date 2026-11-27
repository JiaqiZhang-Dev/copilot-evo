# Changelog

All notable changes to `copilot-evo` are documented in this file.

## [0.15.3] - 2026-11-27

### Added
- **Uncaptured turn detection on `session.idle`**: Automatically queues turns that involve cross-turn revisions, error recoveries, follow-up edits, or workflow cues without calling `evo_solidify` into a non-intrusive Canvas banner (`Extract with Copilot` / `Dismiss`), with no noisy chat prompts.
- **Refinement-aware revision check**: Cross-turn re-edit hooks now surface active recalled experience IDs so Copilot can refine an existing rule in place or save a new local rule.

### Fixed
- **PR & Markdown doc recall**: Extract `pull_request` / `pr_description` / `documentation` / `markdown` signals, recall relevant rules in `onPreToolUse` when creating PRs or editing `.md` files, and avoid auto-muting unvoted experiences.

## [0.15.2] - 2026-11-26

### Added
- **Path-scoped recall (`pathPatterns`)**: Support optional repo-relative glob patterns (e.g., `tools/sdk-ai-bots/**`) on experiences so auto-recall triggers only when matching files are active.
- **Session recall cooldown**: Skip re-injecting the exact same experience on consecutive prompt turns within the cooldown window (5 turns / 10 minutes).
- **Low-ROI auto-muting**: Automatically exclude unpinned experiences with high recalls (`recallCount >= 10`) and low helpfulness (`successCount <= 1`) from passive injection while keeping them searchable via `evo_search`.

## [0.15.1] - 2026-11-25

### Added
- **BM25 + synonym expansion recall**: Upgrade `selectAssets()` with BM25 scoring and domain synonym expansion (e.g., `pr` ↔ `pull_request`, `description` ↔ `summary`).
- **PR creation/edit recall**: Extract `pull_request` / `pr_description` signals and recall PR rules before `pull_request` or `gh pr create` / `gh pr edit` tool calls.
- **Copilot-driven graduation PRs**: Delegate **Graduate to Repo** to Copilot to inspect existing `.github/` instructions/skills, merge or draft a structured skill/instructions file, and open a PR with `evo_graduate` (`markOnly: true`).
- **Repo graduation checklist**: Show clear eligibility criteria (`Needs <repo> session`, `Helpful`, `Pass`, `Score`) with hover tooltips in the Canvas detail drawer.

### Fixed
- **Hidden follow-up detection**: Replace visible `onAgentStop` blocks with hidden `additionalContext` trajectory checks and track `gh pr edit` targets across turns.
- **Detail header layout**: Fix horizontal clipping for long experience titles/IDs and simplify score display while keeping the 4-metric breakdown bars.

## [0.15.0] - 2026-11-25

### Added
- **Experience Graduation**: Add `findGraduationCandidates`, `recommendGraduationTarget`, `renderGraduationArtifact`, `graduateAsset`, and the `evo_graduate` tool to graduate high-frequency repo-scoped experiences into `.github/` instructions or skills and suppress redundant recall once graduated.

## [0.14.9] - 2026-11-25

### Added
- **Trajectory follow-up detection**: Detect short follow-up edits across turns without relying only on hardcoded phrases.

## [0.14.0] - [0.14.8] - 2026-11-24

### Added
- **Decoupled private team repo**: Remove bundled team experiences from the plugin, add `configure` action to `evo_sync_repo`, and add the **Private Team Repository** modal in Canvas UI (`Connect Existing`, `Create Private Repo`, `Disconnect`).
- **Documentation & Quick Start**: Add 3-step Quick Start with screenshots, Before/After comparison table, and plugin logo.

### Fixed
- **Score preservation**: Preserve `successCount` and pending score deltas when updating or refining an experience in place.
- **Disconnect cleanup**: Remove synced team items from local store when disconnecting a team repo.
- **Canvas UX**: Fix modal input sizing, inline loading indicator, and GitHub repo URL normalization.
