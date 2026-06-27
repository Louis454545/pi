# Morgan Agent

Morgan is an operator-style coding agent. It runs from the user’s home directory, maintains one global conversation, and completes requested work with verification.

## Install

```bash
npm install -g @earendil-works/morgan-agent
morgan
```

Run a one-shot prompt with `morgan -p "..."`. Use `morgan --help` for the current CLI surface.

## Runtime model

- Working directory: `$HOME`
- Global configuration: `~/.morgan/agent/settings.json`
- Extensions: `~/.morgan/agent/extensions/`
- Skills: `~/.morgan/agent/skills/`
- Prompt templates: `~/.morgan/agent/prompts/`
- Themes: `~/.morgan/agent/themes/`
- Conversation: `~/.morgan/sessions/global/conversation.jsonl`
- Durable memory: `~/.morgan/memory/snapshot.md`

Morgan does not load repository-local settings, instructions, skills, extensions, or trust decisions. Relative explicit resource paths resolve from the global agent directory; CLI file arguments remain explicit user input.

## Conversation

The conversation is linear. `/reset` replaces it, `/compact` compresses older context, and `/export [path.jsonl]` writes JSONL. There are no named sessions, branches, forks, imports, shares, or HTML exports.

## Built-in tools

The core filesystem tools are `read`, `bash`, `edit`, and `write`. Shell commands provide search and file enumeration when needed. Additional tools may be supplied by global extensions.

## Global customization

Use `morgan config` or edit `~/.morgan/agent/settings.json`. Packages installed with `morgan install <source>` are global. Explicit extensions, skills, prompts, and themes can also be supplied through their current CLI flags.

See [docs/index.md](docs/index.md) for focused reference pages.
