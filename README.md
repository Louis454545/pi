<p align="center">
  <a href="https://morgan.dev">
    <img alt="morgan logo" src="https://morgan.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>
<p align="center">
  <a href="https://morgan.dev">morgan.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/morgan-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Morgan Agent Harness Mono Repo

This is the home of the morgan agent harness project including our self-extensible computer agent.

* **[@earendil-works/morgan-agent](packages/morgan-agent)**: Interactive computer agent CLI
* **[@earendil-works/morgan-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/morgan-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about morgan:

* [Visit morgan.dev](https://morgan.dev), the project website with demos
* [Read the documentation](https://morgan.dev/docs/latest), but you can also ask the agent to explain itself

## Share Your OSS Morgan Conversations

If you use morgan or other agents for open source work, please share your conversations.

Public OSS conversation data helps improve agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/morgan-share-hf`](https://github.com/badlogic/morgan-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `morgan-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `morgan-mono` sessions.

I regularly publish my own `morgan-mono` work sessions here:

- [badlogicgames/morgan-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/morgan-mono)

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/morgan-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/morgan-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/morgan-agent](packages/morgan-agent)** | Interactive computer agent CLI |
| **[@earendil-works/morgan-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/morgan-chat](https://github.com/earendil-works/morgan-chat).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./morgan-test.sh         # Run morgan from sources (can be run from any directory)
```

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` so npm persists direct dependency changes as exact versions.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `MORGAN_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated morgan-agent shrinkwrap.
- The published CLI package includes `packages/morgan-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `morgan update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT
