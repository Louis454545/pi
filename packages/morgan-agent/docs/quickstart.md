# Quickstart

This page gets you from install to a useful first morgan session.

## Install

Morgan is distributed as an npm package:

```bash
npm install -g --ignore-scripts @earendil-works/morgan-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Morgan does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed morgan. The curl installer uses npm globally, so curl and npm installs are removed with npm:

```bash
# curl installer or npm install -g
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
