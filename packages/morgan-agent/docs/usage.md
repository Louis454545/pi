# Usage

Start interactive mode with `morgan`. Run one-shot mode with `morgan -p "request"` and RPC mode with `morgan --mode rpc`.

Morgan always operates from `$HOME`. It does not infer a workspace from the shell launch directory and has no command for changing runtime directory.

Interactive commands include `/model`, `/settings`, `/reset`, `/compact`, `/export`, `/copy`, `/reload`, `/hotkeys`, `/login`, `/logout`, and `/quit`.

The single global conversation lives at `~/.morgan/sessions/global/conversation.jsonl`. `/reset` replaces it. `/export` writes JSONL.

Global resources live under `~/.morgan/agent/`. Repository-local configuration and instruction discovery are not supported.
