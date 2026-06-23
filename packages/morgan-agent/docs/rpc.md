# RPC mode

Start newline-delimited JSON RPC on stdin/stdout with:

```bash
morgan --mode rpc
```

The authoritative request and response unions are exported from `modes/rpc/rpc-types.ts`. Core commands cover prompting, steering/follow-up, abort, model and thinking selection, tools, compaction, reset, JSONL export, reload, messages, commands, and state.

The runtime always uses `$HOME` and the single global conversation. RPC has no cwd switch, session list, session names, session switching, fork/clone, statistics command, or HTML export.
