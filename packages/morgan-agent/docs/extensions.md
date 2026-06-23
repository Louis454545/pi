# Extensions

Extensions are executable TypeScript or JavaScript modules loaded globally from `~/.morgan/agent/extensions/`, installed global packages, or explicit CLI paths.

An extension can register tools, commands, shortcuts, providers, renderers, widgets, triggers, and event handlers. Use the exported SDK types as the authoritative API; removed session-tree, project-trust, project-resource, session-name, and session-switch APIs are not supported.

```ts
import type { ExtensionAPI } from "@earendil-works/morgan-agent";

export default function extension(morgan: ExtensionAPI) {
  morgan.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (_args, ctx) => ctx.ui.notify("hello", "info"),
  });
}
```

Run `/reload` after changing a global extension. Extension code has the same host permissions as Morgan.
