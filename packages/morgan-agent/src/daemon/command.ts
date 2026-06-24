import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { sleep } from "../utils/sleep.ts";
import { disableDaemonAutostart, enableDaemonAutostart, getDaemonAutostartStatus } from "./autostart.ts";
import { DaemonClient } from "./client.ts";
import { runDaemonInteractiveMode } from "./interactive.ts";
import { getDaemonPaths } from "./paths.ts";
import type { DaemonStatus } from "./protocol.ts";
import { createDaemonRunInvocation, runDaemonServer } from "./server.ts";
import { readDaemonState, removeDaemonState } from "./state.ts";

export type DaemonCommand =
	| { type: "help" }
	| { type: "start"; agentArgs: string[] }
	| { type: "run"; agentArgs: string[] }
	| { type: "stop" }
	| { type: "status" }
	| { type: "autostart"; action: "enable" | "disable" | "status" }
	| { type: "restart"; agentArgs: string[] }
	| { type: "prompt"; message: string | undefined }
	| { type: "attach" }
	| { type: "error"; message: string };

function printDaemonHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} daemon start [-- <agent options>]
  ${APP_NAME} daemon stop
  ${APP_NAME} daemon status
  ${APP_NAME} daemon autostart enable|disable|status
  ${APP_NAME} daemon restart [-- <agent options>]
  ${APP_NAME} daemon prompt <message>
  ${APP_NAME} daemon attach

Commands:
  start      Start a background agent daemon exposing the RPC protocol locally
  stop       Stop the running daemon
  status     Show daemon process and socket information
  autostart  Enable, disable, or inspect launch-at-login integration
  restart    Restart the daemon
  prompt     Send one prompt to the daemon and print the last assistant response
  attach     Open the interactive TUI connected to the daemon

Agent options after "--" are passed to the headless agent process.
Examples:
  ${APP_NAME} daemon start -- --model anthropic/claude-sonnet-4-5
  ${APP_NAME} daemon prompt "Summarize this repository"
`);
}

export function parseDaemonCommand(args: string[]): DaemonCommand | undefined {
	if (args[0] !== "daemon") {
		return undefined;
	}

	const subcommand = args[1];
	const rest = args.slice(2);
	if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
		return { type: "help" };
	}

	const separatorIndex = rest.indexOf("--");
	const hasSeparator = separatorIndex !== -1;
	const leadingArgs = hasSeparator ? rest.slice(0, separatorIndex) : rest;
	const agentArgs = hasSeparator ? rest.slice(separatorIndex + 1) : [];

	switch (subcommand) {
		case "start":
		case "restart":
			if (leadingArgs.length > 0) {
				return {
					type: "error",
					message: `${subcommand} options for the agent must be placed after "--"`,
				};
			}
			return { type: subcommand, agentArgs };

		case "run":
			return { type: "run", agentArgs: rest };

		case "stop":
		case "status":
		case "attach":
			if (rest.length > 0) {
				return { type: "error", message: `${subcommand} does not accept arguments` };
			}
			return { type: subcommand };

		case "connect":
			if (rest.length > 0) {
				return { type: "error", message: "connect does not accept arguments" };
			}
			return { type: "attach" };

		case "autostart": {
			const action = rest[0];
			if (rest.length !== 1 || (action !== "enable" && action !== "disable" && action !== "status")) {
				return { type: "error", message: "autostart requires enable, disable, or status" };
			}
			return { type: "autostart", action };
		}

		case "prompt":
			return { type: "prompt", message: rest.length > 0 ? rest.join(" ") : undefined };

		default:
			return { type: "error", message: `Unknown daemon command: ${subcommand}` };
	}
}

async function readPipedStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data.trim() || undefined));
		process.stdin.resume();
	});
}

async function tryGetDaemonStatus(): Promise<DaemonStatus | undefined> {
	const client = new DaemonClient();
	try {
		await client.connect();
		return await client.getStatus();
	} catch {
		return undefined;
	} finally {
		client.close();
	}
}

async function waitForDaemonStatus(timeoutMs: number): Promise<DaemonStatus> {
	const deadline = Date.now() + timeoutMs;
	let lastStatus: DaemonStatus | undefined;
	while (Date.now() < deadline) {
		lastStatus = await tryGetDaemonStatus();
		if (lastStatus) {
			return lastStatus;
		}
		await sleep(100);
	}

	throw new Error(lastStatus ? "Timed out waiting for daemon readiness" : "Daemon did not become reachable");
}

async function stopDaemon(allowAlreadyStopped: boolean): Promise<boolean> {
	const client = new DaemonClient();
	try {
		await client.connect();
	} catch (error: unknown) {
		if (allowAlreadyStopped) {
			return false;
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return false;
	}

	try {
		await client.shutdown();
		await waitForDaemonStopped(5000);
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return false;
	} finally {
		client.close();
	}
}

function daemonFilesExist(): boolean {
	const paths = getDaemonPaths();
	return existsSync(paths.stateFile) || (process.platform !== "win32" && existsSync(paths.socketPath));
}

function ensureDaemonDir(): void {
	const paths = getDaemonPaths();
	mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		chmodSync(paths.daemonDir, 0o700);
		mkdirSync(paths.socketDir, { recursive: true, mode: 0o700 });
		chmodSync(paths.socketDir, 0o700);
	}
}

async function waitForDaemonStopped(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await tryGetDaemonStatus();
		if (!status && !daemonFilesExist()) {
			return;
		}
		await sleep(100);
	}
	throw new Error("Timed out waiting for daemon shutdown cleanup");
}

function reportDaemonCommandError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(chalk.red(`Error: ${message}`));
	process.exitCode = 1;
}

async function startDaemon(agentArgs: string[]): Promise<void> {
	const paths = getDaemonPaths();
	const existing = await tryGetDaemonStatus();
	if (existing) {
		console.log(`${APP_NAME} daemon already running (pid ${existing.pid})`);
		return;
	}

	if (readDaemonState(paths)) {
		removeDaemonState(paths);
	}

	ensureDaemonDir();
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

	const status = await waitForDaemonStatus(5000);
	console.log(`${APP_NAME} daemon started (pid ${status.pid})`);
	console.log(chalk.dim(`socket: ${status.socketPath}`));
	console.log(chalk.dim(`log: ${paths.logFile}`));
}

function printStatus(status: DaemonStatus | undefined): void {
	if (!status) {
		console.log(`${APP_NAME} daemon is not running`);
		return;
	}

	console.log(`${APP_NAME} daemon is running (pid ${status.pid})`);
	if (status.childPid) {
		console.log(`agent pid: ${status.childPid}`);
	}
	console.log(`cwd: ${status.cwd}`);
	console.log(`socket: ${status.socketPath}`);
	console.log(`started: ${status.startedAt}`);
}

async function printAutostartStatus(): Promise<void> {
	const status = await getDaemonAutostartStatus();
	if (!status.supported) {
		console.log(status.message);
		return;
	}
	console.log(`${APP_NAME} daemon autostart is ${status.enabled ? "enabled" : "disabled"} (${status.provider})`);
	console.log(`path: ${status.path}`);
	if (status.message) {
		console.log(chalk.yellow(`Warning: ${status.message}`));
	}
}

async function runPrompt(messageArg: string | undefined): Promise<void> {
	const stdinMessage = messageArg ? undefined : await readPipedStdin();
	const message = messageArg ?? stdinMessage;
	if (!message) {
		console.error(chalk.red("Error: daemon prompt requires a message or piped stdin"));
		process.exitCode = 1;
		return;
	}

	const client = new DaemonClient();
	try {
		await client.connect();
		const text = await client.promptAndWaitText(message);
		if (text) {
			process.stdout.write(`${text}\n`);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
	} finally {
		client.close();
	}
}

async function runAttach(): Promise<void> {
	try {
		await runDaemonInteractiveMode();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
	}
}

export async function handleDaemonCommand(args: string[]): Promise<boolean> {
	const command = parseDaemonCommand(args);
	if (!command) {
		return false;
	}

	switch (command.type) {
		case "help":
			printDaemonHelp();
			return true;

		case "error":
			console.error(chalk.red(`Error: ${command.message}`));
			console.error(chalk.dim(`Use "${APP_NAME} daemon --help".`));
			process.exitCode = 1;
			return true;

		case "run":
			try {
				await runDaemonServer({ agentArgs: command.agentArgs });
			} catch (error: unknown) {
				reportDaemonCommandError(error);
			}
			return true;

		case "start":
			try {
				await startDaemon(command.agentArgs);
			} catch (error: unknown) {
				reportDaemonCommandError(error);
			}
			return true;

		case "restart":
			await stopDaemon(true);
			if (process.exitCode) {
				return true;
			}
			try {
				await startDaemon(command.agentArgs);
			} catch (error: unknown) {
				reportDaemonCommandError(error);
			}
			return true;

		case "stop": {
			const stopped = await stopDaemon(false);
			if (stopped) {
				console.log(`${APP_NAME} daemon stopped`);
			}
			return true;
		}

		case "status":
			printStatus(await tryGetDaemonStatus());
			await printAutostartStatus();
			return true;

		case "autostart":
			try {
				if (command.action === "enable") {
					const status = await enableDaemonAutostart();
					if (!status.supported) {
						console.error(chalk.red(status.message));
						process.exitCode = 1;
					} else {
						const settingsManager = SettingsManager.create(homedir(), getAgentDir());
						settingsManager.setDaemonEnabled(true);
						settingsManager.setDaemonStartAtLogin(true);
						settingsManager.setDaemonAutostartProvider(status.provider);
						await settingsManager.flush();
						console.log(`${APP_NAME} daemon autostart enabled (${status.provider})`);
						console.log(chalk.dim(`path: ${status.path}`));
					}
				} else if (command.action === "disable") {
					const status = await disableDaemonAutostart();
					if (!status.supported) {
						console.error(chalk.red(status.message));
						process.exitCode = 1;
					} else {
						const settingsManager = SettingsManager.create(homedir(), getAgentDir());
						settingsManager.setDaemonStartAtLogin(false);
						settingsManager.setDaemonAutostartProvider(status.provider);
						await settingsManager.flush();
						console.log(`${APP_NAME} daemon autostart disabled (${status.provider})`);
					}
				} else {
					await printAutostartStatus();
				}
			} catch (error: unknown) {
				reportDaemonCommandError(error);
			}
			return true;

		case "prompt":
			await runPrompt(command.message);
			return true;

		case "attach":
			await runAttach();
			return true;
	}
}
