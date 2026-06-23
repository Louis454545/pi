# Global conversation

Morgan stores one linear conversation at:

```text
~/.morgan/sessions/global/conversation.jsonl
```

Each line is a current-schema JSON entry. Morgan rejects unsupported schemas instead of migrating them.

- `/reset` replaces the file with a fresh conversation header.
- `/compact` adds a compaction summary and retains recent context.
- `/export [path.jsonl]` exports the current conversation as JSONL.

Morgan has no session list, names, branches, forks, clones, imports, archives, or legacy-session fallback.
