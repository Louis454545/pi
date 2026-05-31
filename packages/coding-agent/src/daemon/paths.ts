import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, getAgentDir } from "../config.ts";

export interface DaemonPaths {
	agentDir: string;
	socketPath: string;
	stateFile: string;
	logFile: string;
}

export function getDaemonPaths(agentDir = getAgentDir()): DaemonPaths {
	const hash = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
	const socketPath =
		process.platform === "win32"
			? `\\\\.\\pipe\\${APP_NAME}-daemon-${hash}`
			: join(tmpdir(), `${APP_NAME}-${hash}.sock`);

	return {
		agentDir,
		socketPath,
		stateFile: join(agentDir, "daemon.json"),
		logFile: join(agentDir, "daemon.log"),
	};
}
