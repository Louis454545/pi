# Skills

Global skills live at `~/.morgan/agent/skills/<name>/SKILL.md`. Explicit skill paths can also be configured globally or supplied through the CLI.

```md
---
name: example
description: Use when the request needs the example workflow.
---

Follow the workflow here.
```

Morgan loads skills from the global agent directory, global settings, packages, and explicit CLI paths.
