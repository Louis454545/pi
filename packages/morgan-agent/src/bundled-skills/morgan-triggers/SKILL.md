---
name: morgan-triggers
description: Use when creating, auditing, editing, or debugging Morgan proactive triggers, persistent reminders, trigger extensions, file watchers, webhook/inbox/CI watchers, cron/interval scheduled tasks, or automations that emit events into the agent runtime.
---

# Morgan Triggers

Use this skill when the user wants Morgan to react to events while it is running — either external events (file changes, webhooks, CI) or time-based events (cron/interval). Triggers are trusted extension code registered with `morgan.registerTrigger()`.

A trigger has exactly one event source:

- **Event-based** — provide `start(ctx, emit)`. Set up a watcher/poller and call `emit()` when something happens.
- **Time-based** — provide `schedule` (cron or interval) plus `run(ctx, emit)`. The runtime owns the timer and calls `run` on each tick; do work and `emit()` a notification.

Choose the most direct reliable source already available. Prefer push-based APIs, subscriptions, filesystem watchers, webhooks, streams, or native events over periodic polling. Use polling only when the source exposes no reliable event mechanism, and keep each check targeted and inexpensive. Inspect active integrations and existing authenticated clients before creating another connection.

The trigger decides what deserves Morgan's attention. Emit only changes that require contextual evaluation or action, with concise bounded payloads; suppress heartbeats, routine logs, unchanged state, and duplicate events. If the watcher itself fails, emit one concise failure event so Morgan can diagnose and repair or replace it, then avoid a repeated error loop. Keep detection separate from consequential action by default.

Triggers automate observation, not Morgan's contextual reasoning. Unless the user explicitly requests deterministic behavior, never embed prewritten replies, canned response lists, keyword-to-response mappings, or final action policy in a trigger. Emit the relevant event and context so the proactive Morgan turn decides what it means and generates the response or action. Deterministic code may handle transport, filtering, deduplication, and other mechanics, but not replace the agent's judgment.

## Workflow

1. Choose the source: `start` for external events, `schedule` + `run` for time-based reminders.
2. Place personal global triggers under `path.join(getAgentDir(), "extensions", "triggers", "<id>")`.
3. Keep trigger names short, stable, lowercase kebab-case, and unique.
4. Emit concise structured events with a short `summary` (and optional `payload`).
5. Establish an initial baseline, and deduplicate or coalesce events when the source can be noisy.
6. Respect `ctx.signal` and return cleanup for timers, watchers, sockets, polling loops, and child processes.
7. Validate representative transitions, then reduce redundant checks and revalidate only when the source shows evidence of drift.
8. After creating, editing, or deleting a trigger extension, call the reload tool so Morgan starts the new trigger runtime.

## Persistent reminders

Use a global trigger for every reminder or follow-up that must survive the current conversation or a Morgan restart. Do not use `monitor` for durable reminders. Morgan may create a contextually valuable reminder without asking or announcing routine setup; do not turn every future date or passing interest into a trigger.

For a one-time reminder, store an absolute due time, a stable event ID, and enough durable state beside the trigger to prevent duplicate delivery across reloads. Implement it with `start(ctx, emit)`: compute the remaining delay on every session start, re-arm long delays in bounded chunks when necessary, and emit once when due. If Morgan starts after the due time, emit an overdue event for contextual evaluation rather than assuming it should always be shown or discarded.

The trigger supplies the signal, not the final notification policy. On the proactive turn, Morgan should verify or enrich the information proportionally, then notify, reschedule, adapt, retire, or silently ignore the reminder according to its current value. After handling it, update or remove its durable trigger state and reload when required. When handling or encountering existing reminders, remove or consolidate those that have become completed, stale, redundant, or unlikely to justify the user's attention.

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
- Trigger events invite Morgan to evaluate the current context; they do not require a user-facing response when the event is no longer useful.
- `--no-extensions` disables auto-discovered trigger extensions, but explicit `--extension` paths still load.
