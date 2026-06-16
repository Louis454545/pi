---
name: morgan-triggers
description: Use when creating, auditing, editing, or debugging Morgan proactive triggers, trigger extensions, file watchers, webhook/inbox/CI watchers, cron/interval scheduled tasks, or automations that emit events into the agent runtime.
---

# Morgan Triggers

Use this skill when the user wants Morgan to react to events while it is running — either external events (file changes, webhooks, CI) or time-based events (cron/interval). Triggers are trusted extension code registered with `morgan.registerTrigger()`.

A trigger has exactly one event source:

- **Event-based** — provide `start(ctx, emit)`. Set up a watcher/poller and call `emit()` when something happens.
- **Time-based** — provide `schedule` (cron or interval) plus `run(ctx, emit)`. The runtime owns the timer and calls `run` on each tick; do work and `emit()` a notification.

## Workflow

1. Choose the source: `start` for external events, `schedule` + `run` for time-based reminders.
2. Place personal global triggers under `path.join(getAgentDir(), "extensions", "triggers", "<id>")`.
3. Keep trigger names short, stable, lowercase kebab-case, and unique.
4. Emit concise structured events with a short `summary` (and optional `payload`).
5. Respect `ctx.signal` and return cleanup for timers, watchers, sockets, polling loops, and child processes.
6. After creating, editing, or deleting a trigger extension, call the reload tool so Morgan starts the new trigger runtime.

## Event-based trigger

```typescript
import type { ExtensionAPI } from "@earendil-works/morgan-agent";

export default function (morgan: ExtensionAPI) {
  morgan.registerTrigger({
    name: "inbox-watcher",
    description: "React when an external condition changes",
    start(ctx, emit) {
      const timer = setInterval(() => {
        emit({ summary: "External condition changed", payload: { cwd: ctx.cwd } });
      }, 60_000);

      ctx.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
      return () => clearInterval(timer);
    },
  });
}
```

## Time-based (cron/interval) trigger

```typescript
import type { ExtensionAPI } from "@earendil-works/morgan-agent";

export default function (morgan: ExtensionAPI) {
  morgan.registerTrigger({
    name: "daily-standup",
    description: "Remind about standup every weekday at 9am",
    schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Paris" },
    async run(ctx, emit) {
      const { stdout } = await ctx.exec("git", ["log", "--since=yesterday", "--oneline"]);
      emit({ summary: "Standup time", payload: { commits: stdout } });
    },
  });
}
```

Use `schedule: { intervalMs: 300_000 }` for a fixed interval instead of cron. `ctx.exec(command, args, options?)` runs a workspace command with output truncation and abort wiring.

## When To Read Docs

Read `docs/extensions.md` only when the trigger needs custom tools, commands, flags, complex extension lifecycle behavior, model/context access, or unfamiliar APIs.

## Trigger Behavior

- Triggers start after `session_start` and stop on reload, shutdown, or session replacement.
- `emit({ summary, payload?, eventId?, createdAt? })` delivers a notification to the agent. Morgan reacts on the next turn (immediately when idle, queued while busy). There is no separate "notify the user" step — if the user should be informed, the model simply responds.
- For cron triggers, the runtime computes the next run and re-arms automatically; a tick is skipped if the previous `run` is still in progress.
- `--no-extensions` disables auto-discovered trigger extensions, but explicit `--extension` paths still load.
