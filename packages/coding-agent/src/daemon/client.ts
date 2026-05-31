import { createConnection, type Socket } from "node:net";
import type { ImageContent } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../modes/rpc/jsonl.ts";
import type { RpcCommand, RpcResponse } from "../modes/rpc/rpc-types.ts";
import { getDaemonPaths } from "./paths.ts";
import type { DaemonAdminCommand, DaemonAdminResponse, DaemonStatus } from "./protocol.ts";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;
type DaemonAdminCommandBody = DistributiveOmit<DaemonAdminCommand, "id">;
type DaemonClientResponse = DaemonAdminResponse | RpcResponse;
type DaemonEventListener = (event: unknown) => void;

interface PendingRequest {
	resolve: (response: DaemonClientResponse) => void;
	reject: (error: Error) => void;
}

export interface DaemonClientOptions {
	socketPath?: string;
	requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getRecordType(value: unknown): string | undefined {
	return isRecord(value) && typeof value.type === "string" ? value.type : undefined;
}

function getRecordId(value: unknown): string | undefined {
	return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

function getCommandType(command: RpcCommandBody | DaemonAdminCommandBody): string {
	return command.type;
}

export class DaemonClient {
	private socket: Socket | undefined;
	private detachLineReader: (() => void) | undefined;
	private pendingRequests = new Map<string, PendingRequest>();
	private eventListeners: DaemonEventListener[] = [];
	private requestId = 0;
	private socketError: Error | undefined;
	private readonly socketPath: string;
	private readonly requestTimeoutMs: number;

	constructor(options: DaemonClientOptions = {}) {
		this.socketPath = options.socketPath ?? getDaemonPaths().socketPath;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
	}

	async connect(): Promise<void> {
		if (this.socket) {
			throw new Error("Daemon client already connected");
		}

		const socket = createConnection(this.socketPath);
		this.socket = socket;
		this.detachLineReader = attachJsonlLineReader(socket, (line) => this.handleLine(line));

		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				socket.off("connect", onConnect);
				socket.off("error", onConnectError);
			};
			const onConnect = () => {
				cleanup();
				resolve();
			};
			const onConnectError = (error: Error) => {
				cleanup();
				this.detachLineReader?.();
				this.detachLineReader = undefined;
				this.socket = undefined;
				reject(new Error(`Failed to connect to ${APP_NAME} daemon at ${this.socketPath}: ${error.message}`));
			};
			socket.once("connect", onConnect);
			socket.once("error", onConnectError);
		});

		socket.on("error", (error) => {
			this.socketError = new Error(`Daemon socket error: ${error.message}`);
			this.rejectPendingRequests(this.socketError);
		});
		socket.on("close", () => {
			const error = this.socketError ?? new Error("Daemon socket closed");
			this.rejectPendingRequests(error);
		});
	}

	close(): void {
		this.detachLineReader?.();
		this.detachLineReader = undefined;
		this.socket?.end();
		this.socket?.destroy();
		this.socket = undefined;
		this.pendingRequests.clear();
	}

	onEvent(listener: DaemonEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	async getStatus(): Promise<DaemonStatus> {
		const response = await this.sendAdmin({ type: "daemon_status" });
		if (!response.success) {
			throw new Error(response.error);
		}
		if (response.command !== "daemon_status") {
			throw new Error(`Unexpected daemon response: ${response.command}`);
		}
		return response.data;
	}

	async shutdown(): Promise<void> {
		const response = await this.sendAdmin({ type: "daemon_shutdown" });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		const response = await this.sendRpc(images ? { type: "prompt", message, images } : { type: "prompt", message });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.sendRpc({ type: "get_last_assistant_text" });
		return this.getRpcData<{ text: string | null }>(response).text;
	}

	async promptAndWaitText(message: string, images?: ImageContent[], timeoutMs = 60000): Promise<string | null> {
		const wait = this.waitForAgentEnd(timeoutMs);
		try {
			await this.prompt(message, images);
			await wait.promise;
			return await this.getLastAssistantText();
		} catch (error: unknown) {
			wait.cancel();
			throw error;
		}
	}

	private sendRpc(command: RpcCommandBody): Promise<RpcResponse> {
		return this.send(command) as Promise<RpcResponse>;
	}

	private sendAdmin(command: DaemonAdminCommandBody): Promise<DaemonAdminResponse> {
		return this.send(command) as Promise<DaemonAdminResponse>;
	}

	private send(command: RpcCommandBody | DaemonAdminCommandBody): Promise<DaemonClientResponse> {
		const socket = this.socket;
		if (!socket || socket.destroyed || !socket.writable) {
			throw this.socketError ?? new Error("Daemon client is not connected");
		}

		const id = `daemon_req_${++this.requestId}`;
		const fullCommand = { ...command, id };

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${getCommandType(command)}`));
			}, this.requestTimeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			try {
				socket.write(serializeJsonLine(fullCommand));
			} catch (error: unknown) {
				const writeError = error instanceof Error ? error : new Error(String(error));
				this.pendingRequests.delete(id);
				reject(writeError);
			}
		});
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}

		const type = getRecordType(parsed);
		const id = getRecordId(parsed);
		if ((type === "response" || type === "daemon_response") && id) {
			const pending = this.pendingRequests.get(id);
			if (pending) {
				this.pendingRequests.delete(id);
				pending.resolve(parsed as DaemonClientResponse);
				return;
			}
		}

		for (const listener of this.eventListeners) {
			listener(parsed);
		}
	}

	private waitForAgentEnd(timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
		let unsubscribe = () => {};
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const promise = new Promise<void>((resolve, reject) => {
			timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error("Timeout waiting for daemon agent to become idle"));
			}, timeoutMs);
			unsubscribe = this.onEvent((event) => {
				if (getRecordType(event) !== "agent_end") {
					return;
				}
				if (timeout) {
					clearTimeout(timeout);
				}
				unsubscribe();
				resolve();
			});
		});

		return {
			promise,
			cancel: () => {
				if (timeout) {
					clearTimeout(timeout);
				}
				unsubscribe();
			},
		};
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private getRpcData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
