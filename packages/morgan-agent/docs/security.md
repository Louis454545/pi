# Security

Morgan executes with the user account’s operating-system permissions. It is not an in-process sandbox.

Only global resources under `~/.morgan/agent/`, installed global packages, bundled resources, and explicitly supplied paths are loaded. Repository contents are not treated as executable configuration.

Extensions are executable code. Review global packages and extensions before loading them. Use an operating-system sandbox, container, or virtual machine when stronger isolation is required.
