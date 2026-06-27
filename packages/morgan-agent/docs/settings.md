# Settings

Morgan reads and writes one settings file:

```text
~/.morgan/agent/settings.json
```

Open the interactive settings UI with `/settings` or resource configuration with `morgan config`.

Settings cover models, thinking, compaction, retries, display, global resource paths, global packages, providers, telemetry, and daemon behavior. The `daemon.enabled` setting controls whether normal launches start or reuse the background daemon. `daemon.startAtLogin` records Linux/macOS login startup configured by setup, `/settings`, or `morgan daemon autostart`.

Morgan uses this single settings file as the complete supported settings surface.
