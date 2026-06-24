import { execFile as execFileCallback } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { APP_NAME, ENV_AGENT_DIR } from "../config.ts";
import { type DaemonPaths, getDaemonPaths } from "./paths.ts";
import { createDaemonRunInvocation } from "./server.ts";

const execFile = promisify(execFileCallback);
const SYSTEMD_SERVICE_NAME = `${APP_NAME}-daemon.service`;
const LAUNCHD_LABEL = "com.earendil-works.morgan.daemon";

export type DaemonAutostartProvider = "systemd" | "launchd";
export type DaemonAutostartStatus =
	| {
			supported: true;
			provider: DaemonAutostartProvider;
			enabled: boolean;
			path: string;
			message?: string;
	  }
	| {
			supported: false;
			enabled: false;
			message: string;
	  };

export interface AutostartRunner {
	platform?: NodeJS.Platform;
	homeDir?: string;
	uid?: number;
	execFile?: (command: string, args: string[]) => Promise<void>;
}

function platformOf(runner?: AutostartRunner): NodeJS.Platform {
	return runner?.platform ?? process.platform;
}

function homeDirOf(runner?: AutostartRunner): string {
	return runner?.homeDir ?? homedir();
}

function uidOf(runner?: AutostartRunner): number | undefined {
	return runner?.uid ?? process.getuid?.();
}

async function run(command: string, args: string[], runner?: AutostartRunner): Promise<void> {
	if (runner?.execFile) {
		await runner.execFile(command, args);
		return;
	}
	await execFile(command, args);
}

export function getDaemonAutostartProvider(
	platform: NodeJS.Platform = process.platform,
): DaemonAutostartProvider | undefined {
	if (platform === "linux") {
		return "systemd";
	}
	if (platform === "darwin") {
		return "launchd";
	}
	return undefined;
}

function getSystemdServicePath(homeDir: string): string {
	return join(homeDir, ".config", "systemd", "user", SYSTEMD_SERVICE_NAME);
}

function getLaunchAgentPath(homeDir: string): string {
	return join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function getDaemonAutostartPath(runner?: AutostartRunner): string | undefined {
	const provider = getDaemonAutostartProvider(platformOf(runner));
	if (provider === "systemd") {
		return getSystemdServicePath(homeDirOf(runner));
	}
	if (provider === "launchd") {
		return getLaunchAgentPath(homeDirOf(runner));
	}
	return undefined;
}

function quoteSystemdArg(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
		return value;
	}
	return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function renderSystemdService(paths: DaemonPaths = getDaemonPaths()): string {
	const invocation = createDaemonRunInvocation([]);
	const execStart = [invocation.command, ...invocation.args].map(quoteSystemdArg).join(" ");
	return `[Unit]
Description=Morgan daemon

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=3
Environment=${quoteSystemdArg(`${ENV_AGENT_DIR}=${paths.agentDir}`)}
WorkingDirectory=${quoteSystemdArg(homeDirOf())}
StandardOutput=append:${quoteSystemdArg(paths.logFile)}
StandardError=append:${quoteSystemdArg(paths.logFile)}

[Install]
WantedBy=default.target
`;
}

export function renderLaunchAgentPlist(paths: DaemonPaths = getDaemonPaths()): string {
	const invocation = createDaemonRunInvocation([]);
	const args = [invocation.command, ...invocation.args]
		.map((arg) => `\t\t<string>${escapeXml(arg)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>${ENV_AGENT_DIR}</key>
\t\t<string>${escapeXml(paths.agentDir)}</string>
\t</dict>
\t<key>WorkingDirectory</key>
\t<string>${escapeXml(homeDirOf())}</string>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(paths.logFile)}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(paths.logFile)}</string>
</dict>
</plist>
`;
}

function unsupportedStatus(platform: NodeJS.Platform): DaemonAutostartStatus {
	return {
		supported: false,
		enabled: false,
		message: `${APP_NAME} daemon autostart is supported on Linux and macOS only (current platform: ${platform}).`,
	};
}

export async function enableDaemonAutostart(
	options: { paths?: DaemonPaths; runner?: AutostartRunner } = {},
): Promise<DaemonAutostartStatus> {
	const platform = platformOf(options.runner);
	const provider = getDaemonAutostartProvider(platform);
	if (!provider) {
		return unsupportedStatus(platform);
	}

	const paths = options.paths ?? getDaemonPaths();
	const autostartPath = getDaemonAutostartPath(options.runner);
	if (!autostartPath) {
		return unsupportedStatus(platform);
	}
	mkdirSync(dirname(autostartPath), { recursive: true, mode: 0o700 });
	mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
	chmodSync(paths.daemonDir, 0o700);
	if (provider === "systemd") {
		writeFileSync(autostartPath, renderSystemdService(paths), { encoding: "utf-8", mode: 0o600 });
		chmodSync(autostartPath, 0o600);
		await run("systemctl", ["--user", "daemon-reload"], options.runner);
		await run("systemctl", ["--user", "enable", SYSTEMD_SERVICE_NAME], options.runner);
	} else {
		writeFileSync(autostartPath, renderLaunchAgentPlist(paths), { encoding: "utf-8", mode: 0o600 });
		chmodSync(autostartPath, 0o600);
		await run("launchctl", ["unload", "-w", autostartPath], options.runner).catch(() => undefined);
		await run("launchctl", ["load", "-w", autostartPath], options.runner);
	}

	return { supported: true, provider, enabled: true, path: autostartPath };
}

export async function disableDaemonAutostart(
	options: { runner?: AutostartRunner } = {},
): Promise<DaemonAutostartStatus> {
	const platform = platformOf(options.runner);
	const provider = getDaemonAutostartProvider(platform);
	if (!provider) {
		return unsupportedStatus(platform);
	}

	const autostartPath = getDaemonAutostartPath(options.runner);
	if (!autostartPath) {
		return unsupportedStatus(platform);
	}
	if (provider === "systemd") {
		await run("systemctl", ["--user", "disable", SYSTEMD_SERVICE_NAME], options.runner).catch(() => undefined);
		rmSync(autostartPath, { force: true });
		await run("systemctl", ["--user", "daemon-reload"], options.runner).catch(() => undefined);
	} else {
		await run("launchctl", ["unload", "-w", autostartPath], options.runner).catch(() => undefined);
		rmSync(autostartPath, { force: true });
	}

	return { supported: true, provider, enabled: false, path: autostartPath };
}

export async function getDaemonAutostartStatus(runner?: AutostartRunner): Promise<DaemonAutostartStatus> {
	const platform = platformOf(runner);
	const provider = getDaemonAutostartProvider(platform);
	if (!provider) {
		return unsupportedStatus(platform);
	}

	const autostartPath = getDaemonAutostartPath(runner);
	if (!autostartPath) {
		return unsupportedStatus(platform);
	}
	let enabled = existsSync(autostartPath);
	let message: string | undefined;
	if (provider === "systemd" && enabled) {
		try {
			await run("systemctl", ["--user", "is-enabled", SYSTEMD_SERVICE_NAME], runner);
		} catch {
			enabled = false;
			message = "service file exists but systemd user service is not enabled";
		}
	}
	if (provider === "launchd" && enabled) {
		const uid = uidOf(runner);
		if (uid !== undefined) {
			try {
				await run("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], runner);
			} catch {
				message = "LaunchAgent file exists but launchd does not report it as loaded";
			}
		}
	}

	return { supported: true, provider, enabled, path: autostartPath, message };
}
