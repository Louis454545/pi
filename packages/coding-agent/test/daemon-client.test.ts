import { existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DaemonClient } from "../src/daemon/client.ts";
import { parseDaemonCommand } from "../src/daemon/command.ts";
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
