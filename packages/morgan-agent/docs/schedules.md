# Schedules

Schedules are trusted project-local TypeScript modules that run while morgan is open. They live under `.morgan/schedules` in the active working context and are loaded only when the working context is explicit, such as `morgan --cwd <path>` or after `/cwd <path>`.

Schedules do not create an LLM tool. After editing schedule files, reload them with the built-in reload tool using `scope: "schedules"`, or run `/reload` for a full runtime reload.

## Files

Morgan discovers:

- `.morgan/schedules/*.ts`
- `.morgan/schedules/*/index.ts`

Each file must default-export a schedule created with `defineSchedule()`:

```typescript
import { defineSchedule } from "@earendil-works/morgan-agent/schedules";

export default defineSchedule({
  name: "daily-standup-note",
  description: "Remind the agent to prepare a daily standup note",
  trigger: { cron: "0 9 * * 1-5", timezone: "Europe/Paris" },
  async run(ctx) {
    await ctx.notifyAgent({
      summary: "Prepare today's standup note",
      message: `Working context: ${ctx.cwd}`,
      triggerTurn: true,
    });
  },
});
```

Interval schedules use milliseconds:

```typescript
import { defineSchedule } from "@earendil-works/morgan-agent/schedules";

export default defineSchedule({
  name: "watch-build-log",
  trigger: { intervalMs: 60000 },
  async run(ctx) {
    const result = await ctx.exec("git", ["status", "--short"]);
    if (result.stdout.trim()) {
      await ctx.notifyAgent({
        summary: "Repository has uncommitted changes",
        message: result.stdout,
        triggerTurn: false,
      });
    }
  },
});
```

## Context

`run(ctx)` receives:

- `cwd`: active working context.
- `now`: `Date` when the run started.
- `scheduleName`: validated schedule name.
- `runId`: unique id for the run.
- `signal`: abort signal for reload, reset, cwd changes, import, daemon shutdown, and quit.
- `exec(command, args, options?)`: runs a direct command with no shell in the working context.
- `notifyAgent(input)`: injects a schedule notification into the conversation.

`ctx.exec()` uses the schedule cwd, does not accept a cwd override, has a default timeout, and truncates stdout/stderr before returning them.

`ctx.notifyAgent()` accepts:

- `summary`: required short summary.
- `message`: optional details.
- `data`: optional structured details persisted with the notification.
- `triggerTurn`: start a model turn when idle and authenticated. Defaults to `false`.
- `deliverAs`: `steer`, `followUp`, or `nextTurn`. During streaming, the default is `followUp`.

## Runtime Behavior

- Schedules run only while morgan is open.
- Cron schedules do not catch up missed runs after morgan was closed.
- A schedule never overlaps with itself. If it becomes due while already running, morgan records one pending run and starts it after the current run finishes.
- Duplicate schedule names are reported as errors and none of the duplicates start.
- Invalid schedules appear in `/schedule` with their load error.
- `/schedule` lists loaded schedules, source files, triggers, next run, last run/status, running/pending state, and errors.

## Reloading

After writing or editing `.morgan/schedules` files, ask the agent to call:

```json
{ "scope": "schedules" }
```

on the `reload` tool. The empty reload call and `/reload` still perform a full runtime reload.
