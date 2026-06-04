import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { parseArgs } from "../cli/args.ts";
import {
	APP_NAME,
	ENV_GLOBAL_CONVERSATION_LOCK_HELD,
	ENV_SESSION_DIR,
	expandTildePath,
	getAgentDir,
	isBunBinary,
} from "../config.ts";
import { acquireGlobalConversationLock } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { runMigrations } from "../migrations.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../modes/rpc/jsonl.ts";
import { resolvePath } from "../utils/paths.ts";
import type { DaemonPaths } from "./paths.ts";
import { getDaemonPaths } from "./paths.ts";
import type { DaemonAdminCommand, DaemonAdminResponse, DaemonStatus } from "./protocol.ts";
import { removeDaemonState, writeDaemonState } from "./state.ts";

export interface DaemonServerOptions {
	agentArgs?: string[];
	paths?: DaemonPaths;
}

interface ClientConnection {
	id: number;
	socket: Socket;
	detachLineReader: () => void;
}

interface PendingForward {
	client: ClientConnection;
	originalId: string;
}

interface PendingPromptCompletion {
	client: ClientConnection;
	originalId: string;
}

const RPC_COMMAND_TYPES = new Set<string>([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"get_state",
	"reload",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"compact",
	"set_auto_compaction",
	"abort_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"fork",
	"clone",
	"get_fork_messages",
	"get_last_assistant_text",
	"set_session_name",
	"get_messages",
	"get_commands",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getRecordType(value: unknown): string | undefined {
	return isRecord(value) && typeof value.type === "string" ? value.type : undefined;
}

function getRecordId(value: unknown): string | undefined {
	return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

function getCommandName(value: unknown): string {
	return getRecordType(value) ?? "unknown";
}

function isDaemonAdminCommand(value: unknown): value is DaemonAdminCommand {
	const type = getRecordType(value);
	return type === "daemon_status" || type === "daemon_shutdown";
}

export function shouldRewriteClientMessageForRpc(value: unknown): boolean {
	const type = getRecordType(value);
	return type !== undefined && RPC_COMMAND_TYPES.has(type) && getRecordId(value) !== undefined;
}

function isSuccessfulPromptResponse(value: unknown): boolean {
	return isRecord(value) && value.type === "response" && value.command === "prompt" && value.success === true;
}

function isPromptCompleteEvent(value: unknown): boolean {
	return getRecordType(value) === "prompt_complete";
}

function getPromptCompleteError(value: unknown): string | undefined {
	return isRecord(value) && typeof value.error === "string" ? value.error : undefined;
}

export function shouldTrackPromptCompletion(value: unknown): boolean {
	return isRecord(value) && value.type === "prompt" && value.daemonAwaitCompletion === true;
}

function createCliInvocation(args: string[]): { command: string; args: string[] } {
	if (isBunBinary) {
		return { command: process.execPath, args };
	}

	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot determine morgan CLI entrypoint for daemon process");
	}
	return { command: process.execPath, args: [entrypoint, ...args] };
}

export function createDaemonRunInvocation(agentArgs: string[]): { command: string; args: string[] } {
	return createCliInvocation(["daemon", "run", ...agentArgs]);
}

function createRpcInvocation(agentArgs: string[]): { command: string; args: string[] } {
	return createCliInvocation(["--mode", "rpc", ...agentArgs]);
}

function spawnRpcAgent(agentArgs: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
	const invocation = createRpcInvocation(agentArgs);
	return spawn(invocation.command, invocation.args, {
		cwd: process.cwd(),
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	}) as ChildProcessWithoutNullStreams;
}

async function acquireDaemonGlobalConversationLock(agentArgs: string[]): Promise<(() => Promise<void>) | undefined> {
	const parsed = parseArgs(agentArgs);
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return undefined;
	}

	const launchCwd = process.cwd();
	const agentDir = getAgentDir();
	const workingContextCwd = parsed.cwd !== undefined ? resolvePath(parsed.cwd, launchCwd) : undefined;
	const cwd = workingContextCwd ?? homedir();
	const includeProjectResources = true;
	runMigrations(workingContextCwd);

	const settingsManager = SettingsManager.create(cwd, agentDir, {
		includeProjectSettings: includeProjectResources,
	});
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? resolvePath(parsed.sessionDir, launchCwd) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		settingsManager.getSessionDir();

	return acquireGlobalConversationLock(agentDir, sessionDir);
}

function writeJson(socket: Socket, value: unknown): void {
	if (!socket.destroyed && socket.writable) {
		socket.write(serializeJsonLine(value));
	}
}

function makeAdminError(id: string | undefined, command: string, error: string): DaemonAdminResponse {
	const response: DaemonAdminResponse = { type: "daemon_response", command, success: false, error };
	if (id !== undefined) {
		response.id = id;
	}
	return response;
}

function withId<T extends object>(id: string | undefined, value: T): T & { id?: string } {
	if (id === undefined) {
		return value;
	}
	return { ...value, id };
}

async function canConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timeout);
			socket.off("connect", onConnect);
			socket.off("error", onError);
		};
		const onConnect = () => {
			cleanup();
			socket.end();
			resolve(true);
		};
		const onError = () => {
			cleanup();
			resolve(false);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

export async function runDaemonServer(options: DaemonServerOptions = {}): Promise<never> {
	const paths = options.paths ?? getDaemonPaths();
	const agentArgs = options.agentArgs ?? [];

	mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		chmodSync(paths.daemonDir, 0o700);
		mkdirSync(paths.socketDir, { recursive: true, mode: 0o700 });
		chmodSync(paths.socketDir, 0o700);
	}

	if (process.platform !== "win32" && existsSync(paths.socketPath)) {
		if (await canConnect(paths.socketPath, 250)) {
			throw new Error(`${APP_NAME} daemon is already running at ${paths.socketPath}`);
		}
		rmSync(paths.socketPath, { force: true });
	}

	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	let releaseGlobalLock = await acquireDaemonGlobalConversationLock(agentArgs);
	const childEnv = releaseGlobalLock ? { ...process.env, [ENV_GLOBAL_CONVERSATION_LOCK_HELD]: "1" } : process.env;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawnRpcAgent(agentArgs, childEnv);
	} catch (error: unknown) {
		await releaseGlobalLock?.();
		releaseGlobalLock = undefined;
		throw error;
	}
	let nextClientId = 0;
	let nextForwardId = 0;
	let shuttingDown = false;
	let server: Server | undefined;
	const clients = new Set<ClientConnection>();
	const pendingForwards = new Map<string, PendingForward>();
	const promptForwards = new Map<string, PendingPromptCompletion>();

	const getStatus = (): DaemonStatus => {
		const status: DaemonStatus = {
			pid: process.pid,
			socketPath: paths.socketPath,
			cwd: process.cwd(),
			startedAt,
			uptimeMs: Date.now() - startedAtMs,
		};
		if (child.pid !== undefined) {
			status.childPid = child.pid;
		}
		return status;
	};

	const broadcast = (value: unknown): void => {
		for (const client of clients) {
			writeJson(client.socket, value);
		}
	};

	const removeClient = (client: ClientConnection): void => {
		if (!clients.delete(client)) {
			return;
		}
		client.detachLineReader();
		for (const [forwardedId, pending] of pendingForwards.entries()) {
			if (pending.client === client) {
				pendingForwards.delete(forwardedId);
				promptForwards.delete(forwardedId);
			}
		}
	};

	const handleChildLine = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error: unknown) {
			broadcast({
				type: "daemon_error",
				error: `Failed to parse RPC child output: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}

		if (getRecordType(parsed) === "response") {
			const forwardedId = getRecordId(parsed);
			const pending = forwardedId ? pendingForwards.get(forwardedId) : undefined;
			if (forwardedId && pending && isRecord(parsed)) {
				pendingForwards.delete(forwardedId);
				const pendingPrompt = promptForwards.get(forwardedId);
				if (pendingPrompt && !isSuccessfulPromptResponse(parsed)) {
					promptForwards.delete(forwardedId);
				}
				writeJson(pending.client.socket, { ...parsed, id: pending.originalId });
				return;
			}
			if (forwardedId?.startsWith("daemon_")) {
				return;
			}
		}

		if (isPromptCompleteEvent(parsed)) {
			const forwardedId = getRecordId(parsed);
			const pendingPrompt = forwardedId ? promptForwards.get(forwardedId) : undefined;
			if (forwardedId?.startsWith("daemon_")) {
				if (pendingPrompt) {
					promptForwards.delete(forwardedId);
					writeJson(pendingPrompt.client.socket, {
						type: "daemon_prompt_done",
						id: pendingPrompt.originalId,
						error: getPromptCompleteError(parsed),
					});
				}
				return;
			}
		}

		broadcast(parsed);
	};

	const stopServer = async (): Promise<void> => {
		if (!server) {
			return;
		}
		const activeServer = server;
		server = undefined;
		await new Promise<void>((resolve) => {
			activeServer.close(() => resolve());
			for (const client of clients) {
				client.detachLineReader();
				client.socket.end();
				client.socket.destroy();
			}
			clients.clear();
		});
	};

	const stopChild = async (): Promise<void> => {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		child.kill("SIGTERM");
		const timeout = setTimeout(() => child.kill("SIGKILL"), 1000);
		try {
			await once(child, "exit");
		} finally {
			clearTimeout(timeout);
		}
	};

	const cleanupFiles = (): void => {
		removeDaemonState(paths);
		if (process.platform !== "win32") {
			rmSync(paths.socketPath, { force: true });
		}
	};

	const releaseLock = async (): Promise<void> => {
		const release = releaseGlobalLock;
		releaseGlobalLock = undefined;
		await release?.();
	};

	const shutdown = async (exitCode = 0): Promise<never> => {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		await stopServer();
		await stopChild();
		await releaseLock();
		cleanupFiles();
		process.exit(exitCode);
	};

	const handleAdminCommand = (client: ClientConnection, command: DaemonAdminCommand): void => {
		switch (command.type) {
			case "daemon_status":
				writeJson(
					client.socket,
					withId(command.id, {
						type: "daemon_response",
						command: "daemon_status",
						success: true,
						data: getStatus(),
					} satisfies DaemonAdminResponse),
				);
				return;

			case "daemon_shutdown":
				writeJson(
					client.socket,
					withId(command.id, {
						type: "daemon_response",
						command: "daemon_shutdown",
						success: true,
					} satisfies DaemonAdminResponse),
				);
				setImmediate(() => {
					void shutdown();
				});
				return;
		}
	};

	const handleClientLine = (client: ClientConnection, line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error: unknown) {
			writeJson(
				client.socket,
				makeAdminError(
					undefined,
					"parse",
					`Failed to parse daemon command: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
			return;
		}

		if (isDaemonAdminCommand(parsed)) {
			handleAdminCommand(client, parsed);
			return;
		}

		if (!child.stdin.writable) {
			writeJson(
				client.socket,
				makeAdminError(getRecordId(parsed), getCommandName(parsed), "Daemon RPC child process is not writable"),
			);
			return;
		}

		if (!isRecord(parsed)) {
			writeJson(client.socket, makeAdminError(undefined, "unknown", "Daemon command must be a JSON object"));
			return;
		}

		const originalId = getRecordId(parsed);
		if (originalId && shouldRewriteClientMessageForRpc(parsed)) {
			const forwardedId = `daemon_${client.id}_${++nextForwardId}`;
			pendingForwards.set(forwardedId, { client, originalId });
			if (shouldTrackPromptCompletion(parsed)) {
				promptForwards.set(forwardedId, { client, originalId });
			}
			const { daemonAwaitCompletion: _, ...forwardedCommand } = parsed;
			child.stdin.write(serializeJsonLine({ ...forwardedCommand, id: forwardedId }));
			return;
		}

		child.stdin.write(serializeJsonLine(parsed));
	};

	const detachChildStdout = attachJsonlLineReader(child.stdout, handleChildLine);
	child.stderr.on("data", (chunk) => {
		process.stderr.write(chunk);
	});
	child.on("exit", (code, signal) => {
		detachChildStdout();
		if (shuttingDown) {
			return;
		}
		broadcast({
			type: "daemon_error",
			error: `RPC child exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
		});
		void shutdown(code ?? 1);
	});
	child.on("error", (error) => {
		if (shuttingDown) {
			return;
		}
		broadcast({ type: "daemon_error", error: `RPC child error: ${error.message}` });
		void shutdown(1);
	});

	server = createServer((socket) => {
		const client: ClientConnection = {
			id: ++nextClientId,
			socket,
			detachLineReader: () => {},
		};
		client.detachLineReader = attachJsonlLineReader(socket, (line) => handleClientLine(client, line));
		clients.add(client);
		socket.on("close", () => removeClient(client));
		socket.on("error", () => removeClient(client));
	});

	try {
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(paths.socketPath, () => resolve());
		});
	} catch (error: unknown) {
		detachChildStdout();
		await stopChild();
		await releaseLock();
		cleanupFiles();
		throw error;
	}

	if (process.platform !== "win32") {
		chmodSync(paths.socketPath, 0o600);
	}

	const state = {
		version: 1,
		pid: process.pid,
		socketPath: paths.socketPath,
		cwd: process.cwd(),
		startedAt,
	} as const;
	writeDaemonState(paths, child.pid === undefined ? state : { ...state, childPid: child.pid });

	const signalHandler = () => {
		void shutdown(0);
	};
	process.once("SIGTERM", signalHandler);
	process.once("SIGINT", signalHandler);
	if (process.platform !== "win32") {
		process.once("SIGHUP", signalHandler);
	}

	return new Promise(() => {});
}
