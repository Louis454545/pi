# Packages

Install global packages with:

```bash
morgan install npm:package-name
morgan install git:github.com/owner/repository
morgan remove <source>
morgan update [source]
```

Configured packages are stored in `~/.morgan/agent/settings.json`. Managed npm and git content is installed below `~/.morgan/agent/npm/` and `~/.morgan/agent/git/`.

Packages may expose extensions, skills, prompts, and themes through their `morgan` manifest. Use `morgan config` to enable or disable resolved resources.

Morgan resolves packages only from the global agent configuration and explicit CLI input.
