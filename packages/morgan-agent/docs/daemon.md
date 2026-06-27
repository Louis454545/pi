# Daemon

Normal `morgan` launches use the background daemon by default. If the daemon is already running, Morgan connects to it. If it is not running, Morgan starts it, waits for the local socket, and then opens the daemon-backed TUI.

One-shot prompts also use the daemon:

```sh
morgan -p "summarize my current reminders"
```

The daemon owns the global conversation and local RPC socket. Direct runtime modes stay direct: `morgan --mode rpc`, `morgan --mode json`, `morgan --no-session`, metadata commands, setup/config/package commands, and `morgan daemon ...`.

Runtime-changing flags such as `--model`, `--provider`, `--extension`, `--skill`, `--theme`, and tool allow/deny flags must be applied when the daemon starts:

```sh
morgan daemon restart -- --model anthropic/claude-sonnet-4-5
```

## Commands

```sh
morgan daemon status
morgan daemon stop
morgan daemon restart
morgan daemon prompt "what changed?"
morgan daemon attach
```

## Login Startup

Linux uses a `systemd --user` service. macOS uses a LaunchAgent. Windows login startup is not supported.

```sh
morgan daemon autostart enable
morgan daemon autostart status
morgan daemon autostart disable
```

The setup wizard and `/settings` can also configure login startup on Linux and macOS.
