import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, getAgentDir } from "../config.ts";

export interface DaemonPaths {
	agentDir: string;
	daemonDir: string;
	socketDir: string;
	socketPath: string;
	stateFile: string;
	logFile: string;
}

function getUnixSocketDir(hash: string): string {
	const uid = process.getuid?.() ?? "user";
	const dirName = `${APP_NAME}-daemon-${uid}-${hash}`;
	const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
	if (xdgRuntimeDir && join(xdgRuntimeDir, dirName, "daemon.sock").length < 100) {
		return join(xdgRuntimeDir, dirName);
	}
	if (join(tmpdir(), dirName, "daemon.sock").length < 100) {
		return join(tmpdir(), dirName);
	}
	return join("/tmp", dirName);
}

export function getDaemonPaths(agentDir = getAgentDir()): DaemonPaths {
	const daemonDir = join(agentDir, "daemon");
	const hash = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
	const socketDir = process.platform === "win32" ? daemonDir : getUnixSocketDir(hash);
	const socketPath =
		process.platform === "win32" ? `\\\\.\\pipe\\${APP_NAME}-daemon-${hash}` : join(socketDir, "daemon.sock");

	return {
		agentDir,
		daemonDir,
		socketDir,
		socketPath,
		stateFile: join(daemonDir, "daemon.json"),
		logFile: join(daemonDir, "daemon.log"),
	};
}
