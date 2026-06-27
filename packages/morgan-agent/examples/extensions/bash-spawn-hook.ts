/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   morgan -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@earendil-works/morgan-agent";
import { createBashTool } from "@earendil-works/morgan-agent";

export default function (morgan: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, MORGAN_SPAWN_HOOK: "1" },
		}),
	});

	morgan.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
