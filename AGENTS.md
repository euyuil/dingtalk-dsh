# Repository Guidelines

## Project Structure

- `src/main.ts` starts the standalone CLI with the DSH SDK. `src/plugin.ts` is the Cordis desktop plugin entry point, and `src/client.js` implements its settings UI.
- `src/compose.ts` wires shared bridge logic in `src/core/` to one adapter in `src/hosts/`. Keep CLI and desktop session mappings in separate databases.
- `src/dingtalk.ts` and `src/channels/` handle DingTalk transport, `src/messages.ts` parses incoming messages, and `src/store.ts` handles SQLite persistence.
- `tests/` contains regression tests and shared helpers. `config/plugin.example.yml`, `.env.example`, and `cordis.patch.yml` provide deployment and plugin configuration. `dist/` is generated.

## Build, Test, and Run

Use Node.js 24.13.0 or later in the 24.x series. Run these commands from the repository root in PowerShell.

- `npm.cmd ci` installs dependencies from the lockfile, including the CLI’s SDK.
- `npm.cmd run check` runs TypeScript checks without emitting files.
- `npm.cmd run build` rebuilds `dist/` and copies the desktop client script.
- `npm.cmd test` builds and runs the regression suite.
- `npm.cmd start` runs the built CLI after you configure `.env` from `.env.example`.
- `npm.cmd run pack:plugin` builds and packages the installable desktop plugin `.tgz`.

## Coding Style

Follow the existing strict TypeScript and ESM conventions. Use two-space indentation, single quotes, semicolons, and `.js` extensions in relative TypeScript imports. Use camelCase for functions and variables, PascalCase for types and classes, and lowercase filenames such as `dingtalk-worker.ts`. Follow the existing Chinese wording for user-facing messages and test descriptions.

Write documentation and code comments in English by default. Use Chinese proper nouns where English cannot convey them accurately. Write localized documentation in its target language.

## Testing

Put regression tests in `tests/<module>.test.mjs` using `node:test` and `node:assert/strict`. Reuse `tests/helpers.mjs` for temporary databases and fixtures. Stub DingTalk and DSH interactions. CI runs the suite on Windows and sets no coverage threshold.

## Commits and Pull Requests

- Follow Conventional Commits for commit messages and PR titles, for example `feat: add DingTalk reply retries`. Write commit messages, PR titles, and PR descriptions in English.
- Merge every change into `main` through a PR using squash merge. Direct pushes and force pushes to `main` are prohibited.
- Use descriptive feature branch names such as `fix/reply-retry`. Agent-branded prefixes such as `codex/`, `claude/`, `copilot/`, and `cursor/` are prohibited. Never include agent credits anywhere in a branch name.
- In PRs, describe the affected mode and how you verified it. Link relevant issues and include screenshots for desktop UI changes.

Install Gitleaks and enable the staged secret scan with `git config --local core.hooksPath .githooks`. Keep real credentials and SQLite data out of Git.

### Coding Agent Attribution

- Never credit coding agents or models in commit messages, including merge and squash messages, or in PR titles or descriptions. Never use coding-agent identities as Git authors, committers, or PR authors, including bot accounts and email aliases.
- The ban applies regardless of capitalization or formatting. It covers `Co-Authored-By: Claude <noreply@anthropic.com>`, Claude model-name variants, and any agent credit in `Co-authored-by:`, `Assisted-by:`, `Generated-by:`, `Committed-By-Agent:`, `Signed-off-by:`, `Reviewed-by:`, or other trailers.
- Omit agent attribution in footers such as `🤖 Generated with Claude Code` and `Made with Cursor`, badges, hidden HTML comments, and session links or IDs such as `Claude-Session:`.
- Disable automatic attribution where supported. Verify branch names, Git identities, commit messages, and raw PR text before publishing or merging. Use a different workflow if a tool cannot comply.
