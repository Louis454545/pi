# Quickstart

This page gets you from install to a useful first morgan session.

## Install

Install Morgan with the release installer:

```bash
curl -fsSL https://morgan.dev/install.sh | sh
```

The installer downloads the release archive for your platform, verifies it against `SHA256SUMS`, installs `morgan` under `~/.local/share/morgan/current`, and writes a launcher into `~/.local/bin`. The public installer URL is served by the release site; this repository keeps the source script at `scripts/install.sh`.

Manual package-manager install, once the npm packages are published:

```bash
npm install -g --ignore-scripts @earendil-works/morgan-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during npm installs. Morgan does not require install scripts for normal npm installs.

The installer launches `morgan setup` after installation when run in an interactive terminal. `morgan` also launches setup on first interactive startup when global settings do not exist. Setup offers a recommended profile, can resume after cancellation, and can defer browser control for later.

For diagnostics:

```bash
morgan doctor
```

For non-interactive provisioning:

```bash
morgan setup --yes --profile recommended --browser later --provider anthropic --model claude-opus-4-8 --api-key "$ANTHROPIC_API_KEY"
```

### Uninstall

For the release installer:

```bash
rm -f ~/.local/bin/morgan
rm -rf ~/.local/share/morgan/current
```

For package-manager installs, use the package manager that installed morgan:

```bash
# npm
npm uninstall -g @earendil-works/morgan-agent

# pnpm
pnpm remove -g @earendil-works/morgan-agent

# Yarn
yarn global remove @earendil-works/morgan-agent

# Bun
bun uninstall -g @earendil-works/morgan-agent
```

Uninstalling morgan leaves settings, credentials, sessions, and installed morgan packages in `~/.morgan/agent/`.

Then start morgan in the project directory you want it to work on:

```bash
cd /path/to/project
morgan
```

`morgan setup` configures global defaults, enables bundled skills, and can install the bundled browser harness into `~/.morgan/agent/browser-harness`. If browser setup cannot finish, Morgan still starts and reports browser setup as pending. Run `morgan doctor` to inspect setup, auth, browser control, and self-update support.

## Authenticate

Morgan can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start morgan and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching morgan:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
morgan
```

You can also run `/login` and select an API-key provider to store the key in `~/.morgan/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once morgan starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, morgan gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Morgan runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give morgan project instructions

Morgan loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Morgan loads:

- `~/.morgan/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart morgan, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
morgan @README.md "Summarize this"
morgan @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue Later

Morgan saves one global conversation automatically:

```bash
morgan                         # Continue the global conversation
morgan --cwd .                 # Continue with this directory as working context
morgan --no-session            # Ephemeral mode; do not save
```

Inside morgan, use `/cwd`, `/reset`, `/import`, and `/tree` to manage the global conversation.

### Non-interactive mode

For one-shot prompts:

```bash
morgan -p "Summarize this codebase"
cat README.md | morgan -p "Summarize this text"
morgan -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Morgan](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Morgan Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
