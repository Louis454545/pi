import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DaemonPaths } from "./paths.ts";

export interface DaemonStateFile {
	version: 1;
	pid: number;
	childPid?: number;
	socketPath: string;
	cwd: string;
	startedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readDaemonState(paths: DaemonPaths): DaemonStateFile | undefined {
	if (!existsSync(paths.stateFile)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(readFileSync(paths.stateFile, "utf-8")) as unknown;
		if (!isRecord(parsed)) {
			return undefined;
		}
		if (
			parsed.version !== 1 ||
			typeof parsed.pid !== "number" ||
			typeof parsed.socketPath !== "string" ||
			typeof parsed.cwd !== "string" ||
			typeof parsed.startedAt !== "string"
		) {
			return undefined;
		}
		const state: DaemonStateFile = {
			version: 1,
			pid: parsed.pid,
			socketPath: parsed.socketPath,
			cwd: parsed.cwd,
			startedAt: parsed.startedAt,
		};
		if (typeof parsed.childPid === "number") {
			state.childPid = parsed.childPid;
		}
		return state;
	} catch {
		return undefined;
	}
}

export function writeDaemonState(paths: DaemonPaths, state: DaemonStateFile): void {
	writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	chmodSync(paths.stateFile, 0o600);
}

export function removeDaemonState(paths: DaemonPaths): void {
	rmSync(paths.stateFile, { force: true });
}
