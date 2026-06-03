# Global Conversation

Pi saves one canonical global conversation so normal CLI and interactive use continue the same history automatically.

## Storage

The canonical file is:

```text
~/.pi/sessions/global/conversation.jsonl
```

On first launch after upgrading, pi imports the most recent valid legacy session into that file. The old legacy file is left in place.

```bash
pi                         # Continue the global conversation
pi --cwd .                 # Continue with this directory as working context
pi --no-session            # Ephemeral mode; do not save
```

`--cwd <path>` is the explicit working context for tools, AGENTS.md, project settings, and project resources. Without `--cwd` or `/cwd`, pi does not treat the shell launch directory as project context.

For the JSONL file format and advanced SessionManager APIs, see [Session Format](session-format.md).

## Conversation Commands

| Command | Description |
|---------|-------------|
| `/cwd <path>` | Set working context and load project resources |
| `/reset` | Archive and reset the global conversation |
| `/import <file>` | Import a JSONL file into the global conversation |
| `/name <name>` | Set the conversation display name |
| `/session` | Show conversation info |
| `/tree` | Navigate the current conversation tree |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export conversation to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

`/new` is a deprecated alias for `/reset`. Legacy CLI flags such as `--continue`, `--resume`, `--session`, `--session-id`, and `--fork` are parsed for compatibility but are hidden from normal UX.

## Reset and Import

`/reset` archives the current canonical conversation under:

```text
~/.pi/sessions/global/archive/
```

It then creates a fresh canonical conversation with a new session id.

`/import <jsonl>` validates the source JSONL, archives the current canonical file, and replaces the canonical file with the imported entries. The imported header is rewritten to the current session schema and canonical location.

## Naming

Use `/name <name>` to set a human-readable conversation name:

```text
/name Refactor auth module
```

The deprecated `--name` startup flag still parses for compatibility, but `/name` is the normal command.

## Tree Navigation

The global conversation is stored as a tree. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating another conversation file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  <- active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

## Tree Controls

| Key | Action |
|-----|--------|
| Up/Down | Navigate visible entries |
| Left/Right | Page up/down |
| Ctrl+Left/Ctrl+Right or Alt+Left/Alt+Right | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

## Branch Summaries

When `/tree` switches away from one branch to another, pi can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.
