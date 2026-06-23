# SDK

Create a session with `createAgentSession()`:

```ts
import { createAgentSession } from "@earendil-works/morgan-agent";

const { session } = await createAgentSession();
await session.prompt("Inspect the environment and report the result.");
session.dispose();
```

SDK sessions use `$HOME` as their runtime directory. The default session manager opens Morgan’s single global conversation; pass `SessionManager.inMemory()` for an ephemeral conversation.

`CreateAgentSessionOptions` supports model, thinking, auth/model registries, tool allow/deny lists, custom tools, resource loader, settings manager, session manager, and global agent directory overrides. Runtime cwd is fixed to `$HOME`.

Use `createAgentSessionServices()` and `createAgentSessionFromServices()` when composing Morgan’s runtime internals. Use exported extension types for the current extension contract.
