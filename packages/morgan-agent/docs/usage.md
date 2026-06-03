# Using Morgan

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working context, conversation name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `$VISUAL` or `$EDITOR` |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/cwd <path>` | Set explicit working context and load project resources |
| `/reset` | Archive and reset the global conversation |
| `/import <file>` | Import a JSONL file into the global conversation |
| `/name <name>` | Set conversation display name |
| `/session` | Show conversation file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the conversation tree and continue from there |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export conversation to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit morgan |

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want morgan to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Global Conversation

Morgan saves one canonical global conversation at `~/.morgan/sessions/global/conversation.jsonl`. `morgan` and `morgan -p` continue that conversation by default. On first launch after upgrading, morgan imports the most recent valid legacy session into the global conversation.

Use `--cwd <path>` at startup or `/cwd <path>` interactively when you want tools, AGENTS.md, project settings, and project resources loaded from a specific directory. Without an explicit working context, morgan does not use the shell launch directory as project context.

```bash
morgan                         # Continue the global conversation
morgan --cwd .                 # Continue with this directory as working context
morgan --no-session            # Ephemeral mode; do not save
```

Useful conversation commands:

- `/session` shows the current conversation file and ID.
- `/tree` navigates the in-file conversation tree and can summarize abandoned branches.
- `/reset` archives the current canonical conversation and starts fresh.
- `/import <jsonl>` archives the current canonical conversation and imports a JSONL file.
- `/compact` summarizes older messages to free context.

See [Global Conversation](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

Morgan loads `AGENTS.md` or `CLAUDE.md` from:

- `~/.morgan/agent/AGENTS.md` for global instructions

Persistent identity and memory are loaded from global, instance-level files under `~/.morgan/`: `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, daily notes in `memories/daily/`, raw sessions in `sessions/`, and search/index data in `memory-index/`.
- parent directories, walking up from the explicit working context
- the explicit working context directory

Use `--cwd <path>` or `/cwd <path>` to opt into project context files. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.morgan/SYSTEM.md` for the explicit working context
- `~/.morgan/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

## Exporting and Sharing Sessions

Use `/export [file]` to write a conversation to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

If you use morgan for open source work and want to publish sessions for model, prompt, tool, and evaluation research, see [`badlogic/morgan-share-hf`](https://github.com/badlogic/morgan-share-hf). It publishes sessions to Hugging Face datasets.

## CLI Reference

```bash
morgan [options] [@files...] [messages...]
```

### Package Commands

```bash
morgan install <source> [-l]     # Install package, -l for project-local
morgan remove <source> [-l]      # Remove package
morgan uninstall <source> [-l]   # Alias for remove
morgan update [source|self|morgan]   # Update morgan and packages; reconcile pinned git refs
morgan update --extensions       # Update packages only; reconcile pinned git refs
morgan update --self             # Update morgan only
morgan update --extension <src>  # Update one package
morgan list                      # List installed packages
morgan config                    # Enable/disable package resources
```

These commands manage morgan packages, not the morgan CLI installation. To uninstall morgan itself, see [Quickstart](quickstart.md#uninstall).

See [Morgan Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export conversation JSONL to HTML |

In print mode, morgan also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | morgan -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Conversation Options

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Set explicit working context for tools and project resources |
| `--session-dir <dir>` | Custom conversation storage directory |
| `--no-session` | Ephemeral mode; do not save |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools: `read`, `bash`, `edit`, `write`, `reload`, `task_stop`, `monitor`, `subagent`, `grep`, `find`, `ls`.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
morgan --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
morgan @prompt.md "Answer this"
morgan -p @screenshot.png "What's in this image?"
morgan @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
morgan "List all .ts files in src/"

# Non-interactive
morgan -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | morgan -p "Summarize this text"

# Use this directory as working context
morgan --cwd . "Review this project"

# Different model
morgan --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
morgan --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
morgan --model sonnet:high "Solve this complex problem"

# Limit model cycling
morgan --models "claude-*,gpt-4o"

# Read-only mode
morgan --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
morgan --exclude-tools ask_question
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MORGAN_AGENT_DIR` | Override config directory; default is `~/.morgan/agent` |
| `MORGAN_SESSION_DIR` | Override conversation storage directory |
| `MORGAN_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `MORGAN_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `MORGAN_SKIP_VERSION_CHECK` | Skip the Morgan version update check at startup. This prevents the `morgan.dev` latest-version request |
| `MORGAN_TELEMETRY` | Override install/update telemetry: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks |
| `MORGAN_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

## Design Principles

Morgan keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

It intentionally does not include built-in MCP, permission popups, plan mode, or to-dos. Built-in subagents and background tasks are exposed as explicit tools with JSONL/session traces and can still be replaced by extensions.

For the full rationale, read the [blog post](https://mariozechner.at/posts/2025-11-30-morgan-agent/).
