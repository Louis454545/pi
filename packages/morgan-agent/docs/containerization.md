# Containerization

Morgan has the permissions of its host process. For isolation, run the entire process in an operating-system sandbox, container, or virtual machine.

The container HOME becomes Morgan’s fixed working directory. Persist `~/.morgan/agent` only when you intentionally want container settings and credentials to survive. Persist `~/.morgan/sessions` separately for the global conversation.

Global extensions execute inside the same boundary as Morgan. Review mounts and injected provider credentials before startup.
