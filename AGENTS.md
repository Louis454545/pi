# Development Rules

## Morgan Agent Vision

`MORGAN_VISION.md` is the canonical product philosophy for Morgan. Read it in full before changing Morgan's behavior, prompts, tools, memory, skills, extensions, proactive automation, or user experience. Also read it whenever the intended product direction, degree of proactivity, agency boundary, scope, or architectural tradeoff is unclear. Product and implementation decisions must move Morgan toward that vision rather than merely adding capability.

Core invariants:

- Morgan is an operator, not only a chat assistant. It produces verified end-to-end results with minimal avoidable supervision.
- Morgan inspects and reuses the live environment before asking questions or creating another path.
- Morgan delivers the immediate result before generalizing. It uses the simplest reliable solution, then preserves proven reusable knowledge or behavior in the correct durable layer.
- Morgan is proactive primarily through high-value information, contextual follow-up, and durable reminders. It protects the user's attention and may remain silent when an event is not useful.
- Morgan performs implicit work inside the requested objective, but does not turn proactivity into broad scope expansion. Unsolicited actions must be directly related, clearly beneficial, low-risk, reversible, and free of meaningful external commitment.
- Morgan treats recoverable difficulties as implementation feedback. It improves the approach and continues instead of stopping to ask whether the user wants the necessary fix.
- Morgan verifies results, repairs ordinary failures, reports uncertainty honestly, preserves user work, and asks only when ambiguity, authorization, or risk genuinely requires human judgment.
- Loaded extensions, skills, memory, monitors, and triggers are part of Morgan's active capability surface. Morgan must understand their purpose, use them when relevant, and treat load or runtime failures as actionable diagnostics.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/morgan-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/morgan-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/morgan-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/morgan-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-morgan-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `MORGAN_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple morgan sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:morgan-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing morgan Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s morgan-test -x 80 -y 24
tmux send-keys -t morgan-test "./morgan-test.sh" Enter
sleep 3 && tmux capture-pane -t morgan-test -p     # capture after startup
tmux send-keys -t morgan-test "your prompt here" Enter
tmux send-keys -t morgan-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t morgan-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/morgan-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/morgan-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/morgan-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/morgan-local-release/node/morgan --help
   /tmp/morgan-local-release/node/morgan --version
   /tmp/morgan-local-release/node/morgan --list-models
   /tmp/morgan-local-release/node/morgan -p "Say exactly: ok"
   /tmp/morgan-local-release/node/morgan

   # Bun binary smoke tests
   /tmp/morgan-local-release/bun/morgan --help
   /tmp/morgan-local-release/bun/morgan --version
   /tmp/morgan-local-release/bun/morgan --list-models
   /tmp/morgan-local-release/bun/morgan -p "Say exactly: ok"
   /tmp/morgan-local-release/bun/morgan
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/morgan-local-release/node/morgan` and `/tmp/morgan-local-release/bun/morgan` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   MORGAN_ALLOW_LOCKFILE_CHANGE=1 npm run release:patch    # fixes + additions
   MORGAN_ALLOW_LOCKFILE_CHANGE=1 npm run release:minor    # breaking changes
   ```
   Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

## Cursor Cloud specific instructions

Durable, non-obvious notes for Cloud agents (the startup update script already runs `npm install --ignore-scripts`):

- **Node version**: the repo requires Node `>=22.19.0` (`engines.node`), but the pre-baked `/exec-daemon/node` on `PATH` is `v22.14.0`. A compatible Node (nvm default, currently `v22.23.1`) is installed and the agent's `~/.bashrc` prepends it to `PATH`. Interactive/login shells get the right Node automatically. If a non-login shell ever resolves the wrong Node, run `nvm use default` (or `export PATH="$(dirname "$(nvm which default)"):$PATH"`). `npm install` itself is not blocked by the version mismatch (no `engine-strict`).
- **Dependencies**: install with `npm install --ignore-scripts` (per the Dependency and Install Security rules). This skips the `husky` `prepare` script, so git pre-commit hooks are NOT installed by default; run `npm run check` manually before committing (the pre-commit hook would otherwise run it).
- **Run the app (dev)**: `./morgan-test.sh` runs the `morgan` CLI/TUI directly from source via `tsx` (no build needed). It is a single local process; there are no servers, databases, or other services to start.
- **Provider credential required for real agent turns**: with no provider configured, `morgan` starts but shows `No models available` and `-p` prompts hang/produce nothing. Set a provider key (e.g. `GEMINI_API_KEY` — `google` is the default provider — or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), or use `/login` in the TUI. See `packages/morgan-agent/docs/providers.md`.
- **Lint/typecheck**: `npm run check`. **Tests**: `./test.sh` (offline runner that unsets API keys and skips e2e). Do NOT run `npm test` or the full vitest suite directly (see the Commands section). For the interactive TUI, use the tmux recipe in "Testing morgan Interactive Mode with tmux".
- **Optional components** (not needed for core dev/test): the Python/Playwright browser harness and `uv` are absent and surface as warnings in `morgan doctor`; install via `morgan setup --force` only if doing browser-automation work.
