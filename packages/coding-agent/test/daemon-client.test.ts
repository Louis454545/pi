import { existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DaemonClient } from "../src/daemon/client.ts";
import { parseDaemonCommand } from "../src/daemon/command.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { shouldRewriteClientMessageForRpc, shouldTrackPromptCompletion } from "../src/daemon/server.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

const servers: Server[] = [];
const socketPaths: string[] = [];

function makeSocketPath(): string {
	const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-daemon-test-${suffix}`;
	}
	const socketPath = join(tmpdir(), `pi-daemon-test-${suffix}.sock`);
	socketPaths.push(socketPath);
	return socketPath;
}

async function listen(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	servers.push(server);
}

function write(socket: Socket, value: unknown): void {
	socket.write(serializeJsonLine(value));
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const socketPath of socketPaths.splice(0)) {
		if (existsSync(socketPath)) {
			rmSync(socketPath, { force: true });
		}
	}
});

describe("DaemonClient", () => {
	test("rejects pending requests when closed", async () => {
		const socketPath = makeSocketPath();
		const server = createServer((socket) => {
			const detach = attachJsonlLineReader(socket, () => {});
			socket.on("close", detach);
		});
		await listen(server, socketPath);

		const client = new DaemonClient({ socketPath, requestTimeoutMs: 1000 });
		await client.connect();
		const pending = client.getStatus();
		client.close();

		await expect(pending).rejects.toThrow("Daemon client closed");
	});

	test("uses daemon admin and RPC commands over the socket", async () => {
		const socketPath = makeSocketPath();
		const server = createServer((socket) => {
			const detach = attachJsonlLineReader(socket, (line) => {
				const command = JSON.parse(line) as Record<string, unknown>;
				if (command.type === "daemon_status") {
					write(socket, {
						id: command.id,
						type: "daemon_response",
						command: "daemon_status",
						success: true,
						data: {
							pid: 123,
							childPid: 456,
							socketPath,
							cwd: "/tmp/project",
							startedAt: "2026-05-31T00:00:00.000Z",
							uptimeMs: 10,
						},
					});
				} else if (command.type === "prompt") {
					write(socket, { id: command.id, type: "response", command: "prompt", success: true });
					write(socket, { type: "agent_end" });
					write(socket, { type: "daemon_prompt_done", id: command.id });
				} else if (command.type === "get_last_assistant_text") {
					write(socket, {
						id: command.id,
						type: "response",
						command: "get_last_assistant_text",
						success: true,
						data: { text: "daemon response" },
					});
				}
			});
			socket.on("close", detach);
		});
		await listen(server, socketPath);

		const client = new DaemonClient({ socketPath, requestTimeoutMs: 1000 });
		await client.connect();
		try {
			await expect(client.getStatus()).resolves.toMatchObject({ pid: 123, childPid: 456, socketPath });
			await expect(client.promptAndWaitText("hello", undefined, 1000)).resolves.toBe("daemon response");
		} finally {
			client.close();
		}
	});

	test("waits for the daemon prompt completion event for the submitted prompt", async () => {
		const socketPath = makeSocketPath();
		let requestedLastText = false;
		const server = createServer((socket) => {
			const detach = attachJsonlLineReader(socket, (line) => {
				const command = JSON.parse(line) as Record<string, unknown>;
				if (command.type === "prompt") {
					write(socket, { id: command.id, type: "response", command: "prompt", success: true });
					write(socket, { type: "agent_end" });
					setTimeout(() => write(socket, { type: "daemon_prompt_done", id: command.id }), 25);
				} else if (command.type === "get_last_assistant_text") {
					requestedLastText = true;
					write(socket, {
						id: command.id,
						type: "response",
						command: "get_last_assistant_text",
						success: true,
						data: { text: "own prompt" },
					});
				}
			});
			socket.on("close", detach);
		});
		await listen(server, socketPath);

		const client = new DaemonClient({ socketPath, requestTimeoutMs: 1000 });
		await client.connect();
		try {
			await expect(client.promptAndWaitText("hello", undefined, 1000)).resolves.toBe("own prompt");
			expect(requestedLastText).toBe(true);
		} finally {
			client.close();
		}
	});

	test("handles prompts that complete without an agent_end event", async () => {
		const socketPath = makeSocketPath();
		const server = createServer((socket) => {
			const detach = attachJsonlLineReader(socket, (line) => {
				const command = JSON.parse(line) as Record<string, unknown>;
				if (command.type === "prompt") {
					write(socket, { id: command.id, type: "response", command: "prompt", success: true });
					write(socket, { type: "daemon_prompt_done", id: command.id });
				} else if (command.type === "get_last_assistant_text") {
					write(socket, {
						id: command.id,
						type: "response",
						command: "get_last_assistant_text",
						success: true,
						data: { text: null },
					});
				}
			});
			socket.on("close", detach);
		});
		await listen(server, socketPath);

		const client = new DaemonClient({ socketPath, requestTimeoutMs: 1000 });
		await client.connect();
		try {
			await expect(client.promptAndWaitText("/handled", undefined, 1000)).resolves.toBeNull();
		} finally {
			client.close();
		}
	});

	test("rejects prompt waits when the daemon socket closes before completion", async () => {
		const socketPath = makeSocketPath();
		const server = createServer((socket) => {
			const detach = attachJsonlLineReader(socket, (line) => {
				const command = JSON.parse(line) as Record<string, unknown>;
				if (command.type === "prompt") {
					write(socket, { id: command.id, type: "response", command: "prompt", success: true });
					setTimeout(() => socket.destroy(), 10);
				}
			});
			socket.on("close", detach);
		});
		await listen(server, socketPath);

		const client = new DaemonClient({ socketPath, requestTimeoutMs: 1000 });
		await client.connect();
		try {
			await expect(client.promptAndWaitText("hello", undefined, 1000)).rejects.toThrow("Daemon socket closed");
		} finally {
			client.close();
		}
	});

	test("rejects prompt waits when daemon completion reports an error", async () => {
		const socketPath = makeSocketPath();
		const server = createServer((socket) => {
			const detach = attachJsonlLineReader(socket, (line) => {
				const command = JSON.parse(line) as Record<string, unknown>;
				if (command.type === "prompt") {
					write(socket, { id: command.id, type: "response", command: "prompt", success: true });
					write(socket, { type: "daemon_prompt_done", id: command.id, error: "model failed" });
				}
			});
			socket.on("close", detach);
		});
		await listen(server, socketPath);

		const client = new DaemonClient({ socketPath, requestTimeoutMs: 1000 });
		await client.connect();
		try {
			await expect(client.promptAndWaitText("hello", undefined, 1000)).rejects.toThrow("model failed");
		} finally {
			client.close();
		}
	});
});

describe("daemon paths", () => {
	test.runIf(process.platform !== "win32")("uses a short runtime path for the Unix socket", () => {
		const agentDir = join("/tmp", "pi-daemon-path-test", "nested".repeat(30));
		const paths = getDaemonPaths(agentDir);
		expect(paths.daemonDir).toBe(join(agentDir, "daemon"));
		expect(paths.socketDir).not.toBe(paths.daemonDir);
		expect(paths.socketPath).toBe(join(paths.socketDir, "daemon.sock"));
		expect(paths.socketPath.length).toBeLessThan(100);
		expect(paths.stateFile).toBe(join(agentDir, "daemon", "daemon.json"));
		expect(paths.logFile).toBe(join(agentDir, "daemon", "daemon.log"));
	});
});

describe("daemon RPC proxy routing", () => {
	test("rewrites RPC command ids but not extension UI response ids", () => {
		expect(shouldRewriteClientMessageForRpc({ id: "cmd_1", type: "prompt", message: "hi" })).toBe(true);
		expect(shouldRewriteClientMessageForRpc({ id: "ui_1", type: "extension_ui_response", value: "ok" })).toBe(false);
	});

	test("tracks only daemon prompt calls that ask for completion", () => {
		expect(
			shouldTrackPromptCompletion({
				id: "cmd_1",
				type: "prompt",
				message: "hi",
				daemonAwaitCompletion: true,
			}),
		).toBe(true);
		expect(shouldTrackPromptCompletion({ id: "cmd_1", type: "prompt", message: "hi" })).toBe(false);
	});
});

describe("parseDaemonCommand", () => {
	test("parses start agent args after separator", () => {
		expect(parseDaemonCommand(["daemon", "start", "--", "--model", "anthropic/claude"])).toEqual({
			type: "start",
			agentArgs: ["--model", "anthropic/claude"],
		});
	});

	test("rejects start agent args before separator", () => {
		expect(parseDaemonCommand(["daemon", "start", "--model", "anthropic/claude"])).toEqual({
			type: "error",
			message: 'start options for the agent must be placed after "--"',
		});
	});

	test("parses connect as attach alias", () => {
		expect(parseDaemonCommand(["daemon", "connect"])).toEqual({ type: "attach" });
	});
});
