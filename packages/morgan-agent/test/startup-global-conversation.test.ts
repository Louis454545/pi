import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "morgan-startup-global-conversation-"));
	tempDirs.push(dir);
	return dir;
}

interface CliResult {
	code: number | null;
	stderr: string;
}

async function runCli(args: string[], cwd: string, agentDir: string, homeDir: string = homedir()): Promise<CliResult> {
	let stderr = "";
	const child = spawn(process.execPath, [cliPath, ...args], {
		cwd,
		env: {
			...process.env,
			HOME: homeDir,
			[ENV_AGENT_DIR]: agentDir,
			MORGAN_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, 10_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code, stderr });
		});
	});
}

function readHeader(file: string): { id?: string; cwd?: string; type?: string } {
	const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
	return JSON.parse(firstLine) as { id?: string; cwd?: string; type?: string };
}

describe("startup global conversation", () => {
	it("uses one canonical conversation across launch directories", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const homeDir = join(tempRoot, "home");
		const launchA = join(tempRoot, "launch-a");
		const launchB = join(tempRoot, "launch-b");
		const globalConversationFile = join(tempRoot, "sessions", "global", "conversation.jsonl");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(launchA, { recursive: true });
		mkdirSync(launchB, { recursive: true });

		const first = await runCli(["--model", "missing-model", "-p", "hi"], launchA, agentDir, homeDir);
		expect(first.code).toBe(1);
		expect(existsSync(globalConversationFile)).toBe(true);
		const firstHeader = readHeader(globalConversationFile);
		expect(firstHeader).toMatchObject({ type: "session", cwd: resolve(homeDir) });

		const second = await runCli(["--model", "missing-model", "-p", "hi"], launchB, agentDir, homeDir);
		expect(second.code).toBe(1);
		const secondHeader = readHeader(globalConversationFile);
		expect(secondHeader.id).toBe(firstHeader.id);
		expect(secondHeader.cwd).toBe(firstHeader.cwd);
	});

	it("uses --cwd as the explicit working context", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const workspace = join(tempRoot, "workspace");
		const globalConversationFile = join(tempRoot, "sessions", "global", "conversation.jsonl");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(workspace, { recursive: true });

		const result = await runCli(["--cwd", "workspace", "--model", "missing-model", "-p", "hi"], tempRoot, agentDir);
		expect(result.code).toBe(1);
		expect(readHeader(globalConversationFile)).toMatchObject({ type: "session", cwd: resolve(workspace) });
	});

	it("loads home project settings for the default home working context", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const homeDir = join(tempRoot, "home");
		const launchDir = join(tempRoot, "launch");
		const homeMorganDir = join(homeDir, ".morgan");
		const configuredSessionDir = join(tempRoot, "configured-sessions");
		const configuredConversationFile = join(configuredSessionDir, "global", "conversation.jsonl");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(homeMorganDir, { recursive: true });
		mkdirSync(launchDir, { recursive: true });
		writeFileSync(join(homeMorganDir, "settings.json"), JSON.stringify({ sessionDir: configuredSessionDir }));

		const result = await runCli(["--model", "missing-model", "-p", "hi"], launchDir, agentDir, homeDir);
		expect(result.code).toBe(1);
		expect(readHeader(configuredConversationFile)).toMatchObject({ type: "session", cwd: resolve(homeDir) });
	});

	it("keeps --no-session ephemeral", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const launchDir = join(tempRoot, "launch");
		const globalConversationFile = join(tempRoot, "sessions", "global", "conversation.jsonl");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(launchDir, { recursive: true });

		const result = await runCli(["--no-session", "--model", "missing-model", "-p", "hi"], launchDir, agentDir);
		expect(result.code).toBe(1);
		expect(existsSync(globalConversationFile)).toBe(false);
	});
});
