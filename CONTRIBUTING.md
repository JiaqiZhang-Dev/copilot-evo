# Contributing to copilot-evo

Contributions to `copilot-evo` are welcome. Keep changes focused, tested, and aligned with the local-first privacy guarantees of the plugin.

## Development Setup

```bash
git clone https://github.com/JiaqiZhang-Dev/copilot-evo.git
cd copilot-evo
npm test
```

No external runtime dependencies are required outside Node.js (`>= 18.0.0`) and the GitHub Copilot SDK runtime provided by the Copilot host.

## Project Structure

- `plugin.json` — Plugin manifest and version metadata.
- `assets/experiences/` — Bundled generic `starter-rules.json` (team experiences live in each team's own private Git repository).
- `skills/copilot-evo/SKILL.md` — Agent skill instructions for proactive recall, atomic solidification, and sharing confirmation.
- `com.github.copilot/commands/` — Slash commands (`/evo-list`, `/evo-canvas`, `/evo-status`).
- `com.github.copilot/extensions/copilot-evo/` — Core store (`store.mjs`), sanitizer (`sanitize.mjs`), Copilot SDK hooks/tools (`extension.mjs`), loopback Canvas server (`canvas-server.mjs`), and browser UI (`canvas-ui/`).
- `test/` — Unit and integration tests (`sanitize.test.mjs`, `store.test.mjs`, `canvas-server.test.mjs`).

## Guidelines

1. **Syntax & Tests**: Run `node --check` on modified `.mjs`/`.js` files and run `npm test` before committing. Add focused tests for any new store, sanitization, or Canvas API behavior.
2. **Privacy & Safety**: Never relax `sanitize.mjs` leak checks or `isValidationCommandAllowed` command restrictions without test coverage.
3. **Atomic Experiences**: Write all bundled or team-synced Knowledge, Rules, and Fixes in concise English with one focused topic per entry (`2-4` signals, `1-3` steps).
4. **Documentation Style**: Write documentation as the current state in present tense and keep Markdown paragraphs and list items on single lines without hard-wrapping.
