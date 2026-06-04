---
name: morgan-triggers
description: Use when creating, auditing, editing, or debugging Morgan proactive triggers, trigger extensions, file watchers, webhook/inbox/CI watchers, or automations that emit events into the agent runtime.
---

# Morgan Triggers

Use this skill when the user wants Morgan to react to external events while it is running. Triggers are trusted extension code registered with `morgan.registerTrigger()`.

## Workflow

1. Decide whether a trigger is the right primitive. Use schedules for time-based reminders; use triggers for event-based watchers.
2. Place personal global triggers under `path.join(getAgentDir(), "extensions", "triggers", "<id>")`.
3. Keep trigger names short, stable, lowercase kebab-case, and unique.
4. Emit concise structured events with stable `eventId` values for deduplication.
5. Respect `ctx.signal` and return cleanup for timers, watchers, sockets, polling loops, and child processes.
6. After creating, editing, or deleting a trigger extension, call the reload tool so Morgan starts the new trigger runtime.

## Minimal Trigger Extension

For simple triggers, use this pattern without reading the full extensions docs:

```typescript
import type { ExtensionAPI } from "@earendil-works/morgan-agent";

export default function (morgan: ExtensionAPI) {
  morgan.registerTrigger({
    name: "short-trigger-name",
    description: "Watch for an external condition",
    start(ctx, emit) {
      const timer = setInterval(() => {
        emit({
          eventId: `event-${Date.now()}`,
          summary: "External condition changed",
          payload: { cwd: ctx.cwd },
        });
      }, 60_000);

      ctx.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
      return () => clearInterval(timer);
    },
  });
}
```

## When To Read Docs

Read `docs/extensions.md` only when the trigger needs custom tools, commands, flags, complex extension lifecycle behavior, model/context access, or unfamiliar APIs.

## Trigger Behavior

- Triggers start after `session_start` and stop on reload, shutdown, or session replacement.
- `emit({ eventId, summary, payload, createdAt })` creates a hidden proactive event. Morgan starts a proactive turn when idle, or queues it while busy.
- During proactive trigger turns only, the model can use `notify_user` to make the event visible to the user.
- Do not call `notify_user` for every event by default; let the model decide whether the user should be interrupted.
- `--no-extensions` disables auto-discovered trigger extensions, but explicit `--extension` paths still load.
