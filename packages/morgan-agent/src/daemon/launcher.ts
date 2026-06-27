import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { APP_NAME } from "../config.ts";
import { sleep } from "../utils/sleep.ts";
import { DaemonClient } from "./client.ts";
import { type DaemonPaths, getDaemonPaths } from "./paths.ts";
import type { DaemonStatus } from "./protocol.ts";
import { createDaemonRunInvocation } from "./server.ts";
import { readDaemonState, removeDaemonState } from "./state.ts";

export interface EnsureDaemonStartedOptions {
	agentArgs?: string[];
	paths?: DaemonPaths;
	timeoutMs?: number;
}

function ensureDaemonDir(paths: DaemonPaths): void {
	mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
	chmodSync(paths.daemonDir, 0o700);
	if (process.platform !== "win32") {
		mkdirSync(paths.socketDir, { recursive: true, mode: 0o700 });
		chmodSync(paths.socketDir, 0o700);
	}
}

export async function tryGetDaemonStatus(paths: DaemonPaths = getDaemonPaths()): Promise<DaemonStatus | undefined> {
	const client = new DaemonClient({ socketPath: paths.socketPath, socketDir: paths.socketDir });
	try {
		await client.connect();
		return await client.getStatus();
	} catch {
		return undefined;
	} finally {
		client.close();
	}
}

export async function waitForDaemonStatus(
	timeoutMs: number,
	paths: DaemonPaths = getDaemonPaths(),
): Promise<DaemonStatus> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await tryGetDaemonStatus(paths);
		if (status) {
			return status;
		}
		await sleep(100);
	}

	throw new Error(`${APP_NAME} daemon did not become reachable`);
}

function cleanupStaleDaemonFiles(paths: DaemonPaths): void {
	if (readDaemonState(paths)) {
		removeDaemonState(paths);
	}
	if (process.platform !== "win32") {
		rmSync(paths.socketPath, { force: true });
	}
}

function acquireDaemonStartLock(paths: DaemonPaths): Promise<() => Promise<void>> {
	const lockPath = join(paths.daemonDir, "start.lock");
	writeFileSync(lockPath, "", { flag: "a", mode: 0o600 });
	chmodSync(lockPath, 0o600);
	return lockfile.lock(lockPath, {
		realpath: false,
		stale: 30000,
		retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: false },
	});
}

function spawnDaemon(paths: DaemonPaths, agentArgs: string[]): void {
	const invocation = createDaemonRunInvocation(agentArgs);
	const logFd = openSync(paths.logFile, "a", 0o600);
	try {
		const child = spawn(invocation.command, invocation.args, {
			cwd: homedir(),
			env: process.env,
			stdio: ["ignore", logFd, logFd],
			detached: true,
			windowsHide: true,
		});
		child.unref();
	} finally {
		closeSync(logFd);
	}
}

export async function ensureDaemonStarted(options: EnsureDaemonStartedOptions = {}): Promise<DaemonStatus> {
	const paths = options.paths ?? getDaemonPaths();
	const timeoutMs = options.timeoutMs ?? 5000;
	const existing = await tryGetDaemonStatus(paths);
	if (existing) {
		return existing;
	}

	ensureDaemonDir(paths);
	const releaseLock = await acquireDaemonStartLock(paths);
	try {
		const afterLock = await tryGetDaemonStatus(paths);
		if (afterLock) {
			return afterLock;
		}

		cleanupStaleDaemonFiles(paths);
		spawnDaemon(paths, options.agentArgs ?? []);
		return await waitForDaemonStatus(timeoutMs, paths);
	} finally {
		await releaseLock();
	}
}
