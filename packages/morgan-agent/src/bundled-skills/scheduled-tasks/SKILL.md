---
name: scheduled-tasks
description: Use when creating, auditing, editing, or debugging scheduled jobs, cron expressions, crontabs, systemd timers, launchd jobs, Morgan schedules, recurring reminders, or time-based automations.
---

# Scheduled Tasks

Use this skill whenever the task involves recurring execution, cron-like syntax, timers, reminders, or scheduled Morgan automations.

## Workflow

1. Identify the scheduler: cron/crontab, systemd timer, launchd, Morgan schedule, CI scheduler, or app-specific scheduler.
2. Confirm the timezone, frequency, command, working directory, environment, logging, and failure behavior.
3. Prefer explicit absolute paths in scheduled commands. Do not assume shell startup files are loaded.
4. Validate schedule syntax before writing it. For cron, state the exact interpreted cadence in plain language.
5. Add observability: stdout/stderr redirection, log location, or scheduler-native status inspection.
6. For destructive or externally visible actions, ask before enabling the schedule.

## Cron Defaults

- Use five-field cron unless the target scheduler documents seconds or year fields.
- Remember cron usually has a minimal environment. Set required variables inline or source a known env file intentionally.
- Use `cd /path && command` or scheduler-native working-directory fields rather than relying on launch cwd.
- Avoid overlapping runs for non-idempotent jobs. Use `flock` or a scheduler-native concurrency guard when available.
- Prefer `crontab -l` before editing, and preserve existing entries.

## Morgan Schedules

For Morgan-specific schedules:

- For simple reminders, use the pattern below without reading the full schedules docs.
- Inspect the local schedule docs/API before implementation when using intervals, `ctx.exec`, complex trigger behavior, or unfamiliar schedule APIs.
- Write schedules under `.morgan/schedules` in the active working context. For the default home context, that is `~/.morgan/schedules`.
- Do not write personal schedules under the agent config directory `~/.morgan/agent/.morgan/schedules` unless the active working context is explicitly `~/.morgan/agent`.
- For simple reminders, prefer a Morgan schedule over system cron so the notification enters the Morgan conversation.
- After creating, editing, or deleting a Morgan schedule, call the reload tool exactly as `{"scope":"schedules"}`.

Minimal reminder schedule:

```typescript
import { defineSchedule } from "@earendil-works/morgan-agent/schedules";

export default defineSchedule({
  name: "short-kebab-name",
  description: "Short reminder description",
  trigger: { cron: "0 23 * * *", timezone: "Europe/Paris" },
  async run(ctx) {
    await ctx.notifyAgent({
      summary: "Short reminder title",
      message: "Reminder details.",
      triggerTurn: true,
    });
  },
});
```
