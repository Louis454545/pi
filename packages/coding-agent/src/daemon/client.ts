import { statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import type { SessionStats } from "../core/agent-session.ts";
import type { BashResult } from "../core/bash-executor.ts";
import type { CompactionResult } from "../core/compaction/index.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../modes/rpc/jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "../modes/rpc/rpc-types.ts";
import { getDaemonPaths } from "./paths.ts";
import type { DaemonAdminCommand, DaemonAdminResponse, DaemonPromptDoneEvent, DaemonStatus } from "./protocol.ts";

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
	socketDir?: string;
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

function createPromptCommand(message: string, images?: ImageContent[]): RpcCommandBody {
	return images ? { type: "prompt", message, images } : { type: "prompt", message };
}

function createPromptAndWaitCommand(
	message: string,
	images?: ImageContent[],
): RpcCommandBody & { daemonAwaitCompletion: true } {
	return { ...createPromptCommand(message, images), daemonAwaitCompletion: true };
}

function isDaemonPromptDoneEvent(value: unknown): value is DaemonPromptDoneEvent {
	return (
		isRecord(value) &&
		value.type === "daemon_prompt_done" &&
		typeof value.id === "string" &&
		(value.error === undefined || typeof value.error === "string")
	);
}

export class DaemonClient {
	private socket: Socket | undefined;
	private detachLineReader: (() => void) | undefined;
	private pendingRequests = new Map<string, PendingRequest>();
	private pendingWaits = new Set<(error: Error) => void>();
	private eventListeners: DaemonEventListener[] = [];
	private requestId = 0;
	private socketError: Error | undefined;
	private readonly socketPath: string;
	private readonly socketDir: string | undefined;
	private readonly requestTimeoutMs: number;

	constructor(options: DaemonClientOptions = {}) {
		const defaultPaths = getDaemonPaths();
		this.socketPath = options.socketPath ?? defaultPaths.socketPath;
		this.socketDir = options.socketDir ?? (options.socketPath ? undefined : defaultPaths.socketDir);
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
	}

	async connect(): Promise<void> {
		if (this.socket) {
			throw new Error("Daemon client already connected");
		}

		this.assertPrivateSocketDir();
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
			this.rejectPendingWaits(this.socketError);
		});
		socket.on("close", () => {
			const error = this.socketError ?? new Error("Daemon socket closed");
			this.rejectPendingRequests(error);
			this.rejectPendingWaits(error);
		});
	}

	close(): void {
		const error = new Error("Daemon client closed");
		this.rejectPendingRequests(error);
		this.rejectPendingWaits(error);
		this.detachLineReader?.();
		this.detachLineReader = undefined;
		this.socket?.end();
		this.socket?.destroy();
		this.socket = undefined;
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
		const response = await this.sendRpc(createPromptCommand(message, images));
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		const response = await this.sendRpc({ type: "steer", message, images });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		const response = await this.sendRpc({ type: "follow_up", message, images });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async abort(): Promise<void> {
		const response = await this.sendRpc({ type: "abort" });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.sendRpc({ type: "new_session", parentSession });
		return this.getRpcData(response);
	}

	async getState(): Promise<RpcSessionState> {
		const response = await this.sendRpc({ type: "get_state" });
		return this.getRpcData(response);
	}

	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.sendRpc({ type: "set_model", provider, modelId });
		return this.getRpcData(response);
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.sendRpc({ type: "cycle_model", direction });
		return this.getRpcData(response);
	}

	async getAvailableModels(): Promise<Array<{ provider: string; id: string; name: string; reasoning: boolean }>> {
		const response = await this.sendRpc({ type: "get_available_models" });
		return this.getRpcData<{ models: Array<{ provider: string; id: string; name: string; reasoning: boolean }> }>(
			response,
		).models;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const response = await this.sendRpc({ type: "set_thinking_level", level });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.sendRpc({ type: "cycle_thinking_level" });
		return this.getRpcData(response);
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		const response = await this.sendRpc({ type: "set_steering_mode", mode });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		const response = await this.sendRpc({ type: "set_follow_up_mode", mode });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.sendRpc({ type: "compact", customInstructions });
		return this.getRpcData(response);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		const response = await this.sendRpc({ type: "set_auto_compaction", enabled });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async abortCompaction(): Promise<void> {
		const response = await this.sendRpc({ type: "abort_compaction" });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		const response = await this.sendRpc({ type: "set_auto_retry", enabled });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async abortRetry(): Promise<void> {
		const response = await this.sendRpc({ type: "abort_retry" });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async bash(command: string, options?: { excludeFromContext?: boolean }): Promise<BashResult> {
		const response = await this.sendRpc({ type: "bash", command, excludeFromContext: options?.excludeFromContext });
		return this.getRpcData(response);
	}

	async abortBash(): Promise<void> {
		const response = await this.sendRpc({ type: "abort_bash" });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async getSessionStats(): Promise<SessionStats> {
		const response = await this.sendRpc({ type: "get_session_stats" });
		return this.getRpcData(response);
	}

	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.sendRpc({ type: "export_html", outputPath });
		return this.getRpcData(response);
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.sendRpc({ type: "switch_session", sessionPath });
		return this.getRpcData(response);
	}

	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.sendRpc({ type: "fork", entryId });
		return this.getRpcData(response);
	}

	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.sendRpc({ type: "clone" });
		return this.getRpcData(response);
	}

	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.sendRpc({ type: "get_fork_messages" });
		return this.getRpcData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.sendRpc({ type: "get_last_assistant_text" });
		return this.getRpcData<{ text: string | null }>(response).text;
	}

	async setSessionName(name: string): Promise<void> {
		const response = await this.sendRpc({ type: "set_session_name", name });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async reload(): Promise<void> {
		const response = await this.sendRpc({ type: "reload" });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.sendRpc({ type: "get_messages" });
		return this.getRpcData<{ messages: AgentMessage[] }>(response).messages;
	}

	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.sendRpc({ type: "get_commands" });
		return this.getRpcData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	sendExtensionUiResponse(response: RpcExtensionUIResponse): void {
		this.writeNotification(response);
	}

	async promptAndWaitText(message: string, images?: ImageContent[], timeoutMs = 60000): Promise<string | null> {
		const id = this.createRequestId();
		const wait = this.waitForDaemonPromptDone(id, timeoutMs);
		try {
			const response = await this.sendRpc(createPromptAndWaitCommand(message, images), id);
			if (!response.success) {
				throw new Error(response.error);
			}
			await wait.promise;
			return await this.getLastAssistantText();
		} catch (error: unknown) {
			wait.cancel();
			throw error;
		}
	}

	private sendRpc(command: RpcCommandBody, id?: string): Promise<RpcResponse> {
		return this.send(command, id) as Promise<RpcResponse>;
	}

	private sendAdmin(command: DaemonAdminCommandBody): Promise<DaemonAdminResponse> {
		return this.send(command) as Promise<DaemonAdminResponse>;
	}

	private createRequestId(): string {
		return `daemon_req_${++this.requestId}`;
	}

	private send(command: RpcCommandBody | DaemonAdminCommandBody, requestId?: string): Promise<DaemonClientResponse> {
		const socket = this.socket;
		if (!socket || socket.destroyed || !socket.writable) {
			throw this.socketError ?? new Error("Daemon client is not connected");
		}

		const id = requestId ?? this.createRequestId();
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

	private writeNotification(value: RpcExtensionUIResponse): void {
		const socket = this.socket;
		if (!socket || socket.destroyed || !socket.writable) {
			throw this.socketError ?? new Error("Daemon client is not connected");
		}
		socket.write(serializeJsonLine(value));
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

	private waitForDaemonPromptDone(id: string, timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
		let unsubscribe = () => {};
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let onClose = (_error: Error) => {};
		let settled = false;
		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
			}
			unsubscribe();
			this.pendingWaits.delete(onClose);
		};
		const promise = new Promise<void>((resolve, reject) => {
			const rejectOnce = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			};
			onClose = rejectOnce;
			this.pendingWaits.add(onClose);
			timeout = setTimeout(() => {
				rejectOnce(new Error("Timeout waiting for daemon agent to become idle"));
			}, timeoutMs);
			unsubscribe = this.onEvent((event) => {
				if (!isDaemonPromptDoneEvent(event) || event.id !== id) {
					return;
				}
				if (settled) {
					return;
				}
				if (event.error) {
					rejectOnce(new Error(event.error));
					return;
				}
				settled = true;
				cleanup();
				resolve();
			});
		});

		return {
			promise,
			cancel: () => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
			},
		};
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private rejectPendingWaits(error: Error): void {
		for (const reject of this.pendingWaits) {
			reject(error);
		}
		this.pendingWaits.clear();
	}

	private assertPrivateSocketDir(): void {
		if (process.platform === "win32" || !this.socketDir) {
			return;
		}
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(this.socketDir);
		} catch {
			return;
		}
		if (!stats.isDirectory()) {
			throw new Error(`Daemon socket directory is not a directory: ${this.socketDir}`);
		}
		const currentUid = process.getuid?.();
		if (currentUid !== undefined && stats.uid !== currentUid) {
			throw new Error(`Daemon socket directory is not owned by the current user: ${this.socketDir}`);
		}
		if ((stats.mode & 0o077) !== 0) {
			throw new Error(`Daemon socket directory is not private: ${this.socketDir}`);
		}
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
