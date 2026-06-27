import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, getBundledExtensionsDir } from "../config.ts";
import type { SetupPrompter } from "./prompter.ts";

const TELEGRAM_BRIDGE_ID = "telegram-bridge";
const TELEGRAM_BRIDGE_POLL_TIMEOUT_MS = 60_000;

export interface TelegramBridgeSetupResult {
	status: "ready" | "pending" | "skipped";
	messages: string[];
}

export interface TelegramBotIdentity {
	id: number;
	username?: string;
	firstName?: string;
}

export interface TelegramAllowedPeer {
	chatId: number;
	userId?: number;
	offset: number;
	label: string;
}

export interface TelegramBridgeClient {
	validateBot(token: string): Promise<TelegramBotIdentity>;
	clearWebhook(token: string): Promise<void>;
	getLatestOffset(token: string): Promise<number>;
	waitForStart(token: string, timeoutMs: number): Promise<TelegramAllowedPeer | undefined>;
}

export interface TelegramBridgeSetupOptions {
	agentDir?: string;
	force?: boolean;
	prompter: SetupPrompter;
	client?: TelegramBridgeClient;
}

interface TelegramApiResponse<T> {
	ok?: boolean;
	result?: T;
	description?: string;
}

interface TelegramUser {
	id?: number;
	is_bot?: boolean;
	first_name?: string;
	username?: string;
}

interface TelegramChat {
	id?: number;
	type?: string;
	title?: string;
	first_name?: string;
	last_name?: string;
	username?: string;
}

interface TelegramMessage {
	message_id?: number;
	from?: TelegramUser;
	chat?: TelegramChat;
	text?: string;
	caption?: string;
}

interface TelegramUpdate {
	update_id?: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramBridgeConfig {
	enabled: boolean;
	botToken: string;
	botUsername?: string;
	allowedChatIds: number[];
	allowedUserIds: number[];
	dataDir: string;
	pollTimeoutSeconds: number;
}

interface TelegramBridgeState {
	offset: number;
	paused: boolean;
}

class DefaultTelegramBridgeClient implements TelegramBridgeClient {
	async validateBot(token: string): Promise<TelegramBotIdentity> {
		const result = await callTelegramApi<TelegramUser>(token, "getMe", {});
		if (result.id === undefined) {
			throw new Error("Telegram getMe did not return a bot id.");
		}
		return {
			id: result.id,
			username: result.username,
			firstName: result.first_name,
		};
	}

	async clearWebhook(token: string): Promise<void> {
		await callTelegramApi<true>(token, "deleteWebhook", { drop_pending_updates: false });
	}

	async getLatestOffset(token: string): Promise<number> {
		const updates = await callTelegramApi<TelegramUpdate[]>(token, "getUpdates", {
			timeout: 0,
			limit: 100,
			allowed_updates: ["message", "edited_message"],
		});
		return updates.reduce((offset, update) => {
			return typeof update.update_id === "number" ? Math.max(offset, update.update_id + 1) : offset;
		}, 0);
	}

	async waitForStart(token: string, timeoutMs: number): Promise<TelegramAllowedPeer | undefined> {
		const deadline = Date.now() + timeoutMs;
		let offset = 0;

		while (Date.now() < deadline) {
			const timeoutSeconds = Math.max(1, Math.min(10, Math.ceil((deadline - Date.now()) / 1000)));
			const updates = await callTelegramApi<TelegramUpdate[]>(token, "getUpdates", {
				offset,
				timeout: timeoutSeconds,
				allowed_updates: ["message", "edited_message"],
			});
			for (const update of updates) {
				if (typeof update.update_id === "number") {
					offset = Math.max(offset, update.update_id + 1);
				}

				const message = update.message ?? update.edited_message;
				if (!message?.chat || !message.text?.trim().startsWith("/start")) {
					continue;
				}

				const chatId = message.chat.id;
				if (chatId === undefined) {
					continue;
				}
				const userId = message.from?.id;
				return {
					chatId,
					userId,
					offset,
					label: formatTelegramPeer(message.chat, message.from),
				};
			}
		}

		return undefined;
	}
}

async function callTelegramApi<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const payload = (await response.json()) as TelegramApiResponse<T>;
	if (!response.ok || !payload.ok || payload.result === undefined) {
		throw new Error(payload.description ?? `Telegram ${method} failed with HTTP ${response.status}.`);
	}
	return payload.result;
}

function formatTelegramPeer(chat: TelegramChat, user: TelegramUser | undefined): string {
	const chatName = chat.title ?? chat.username ?? chat.first_name ?? `chat ${chat.id ?? "unknown"}`;
	const userName = user?.username ?? user?.first_name;
	if (!userName) {
		return chatName;
	}
	return `${chatName} (${userName})`;
}

function getBundledTelegramBridgeDir(): string {
	return join(getBundledExtensionsDir(), TELEGRAM_BRIDGE_ID);
}

function getInstalledTelegramBridgeDir(agentDir: string): string {
	return join(agentDir, "extensions", "triggers", TELEGRAM_BRIDGE_ID);
}

function parseIdList(value: string): number[] {
	const ids: number[] = [];
	for (const part of value.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) {
			continue;
		}
		const id = Number.parseInt(trimmed, 10);
		if (!Number.isSafeInteger(id)) {
			throw new Error(`Invalid Telegram id: ${trimmed}`);
		}
		ids.push(id);
	}
	return Array.from(new Set(ids));
}

function copyBridgeTemplate(targetDir: string, force: boolean): string | undefined {
	const sourceDir = getBundledTelegramBridgeDir();
	if (!existsSync(join(sourceDir, "index.ts")) || !existsSync(join(sourceDir, "README.md"))) {
		return `Bundled Telegram bridge files were not found at ${sourceDir}.`;
	}

	if (existsSync(targetDir)) {
		if (!force) {
			return undefined;
		}
		rmSync(targetDir, { recursive: true, force: true });
	}

	mkdirSync(dirname(targetDir), { recursive: true, mode: 0o700 });
	cpSync(sourceDir, targetDir, { recursive: true });
	return undefined;
}

function writeConfig(path: string, config: TelegramBridgeConfig): void {
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	chmodSync(path, 0o600);
}

function writeState(path: string, state: TelegramBridgeState): void {
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	chmodSync(path, 0o600);
}

function readExistingConfig(path: string): TelegramBridgeConfig | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	return JSON.parse(readFileSync(path, "utf-8")) as TelegramBridgeConfig;
}

async function collectAllowlist(
	prompter: SetupPrompter,
	client: TelegramBridgeClient,
	token: string,
): Promise<{ chatIds: number[]; userIds: number[]; offset: number }> {
	const mode = await prompter.select<"pair" | "manual">(
		"Choose Telegram allowlist setup:",
		[
			{ id: "pair", label: "Pair with /start" },
			{ id: "manual", label: "Enter IDs manually" },
		],
		{ defaultId: "pair" },
	);

	if (mode === "pair") {
		prompter.info("Send /start to the Telegram bot from the chat you want to allow.");
		const peer = await client.waitForStart(token, TELEGRAM_BRIDGE_POLL_TIMEOUT_MS);
		if (peer) {
			prompter.info(`Allowed Telegram chat: ${peer.label}`);
			return {
				chatIds: [peer.chatId],
				userIds: peer.userId === undefined ? [] : [peer.userId],
				offset: peer.offset,
			};
		}
		prompter.warn("No /start message received. Falling back to manual Telegram IDs.");
	}

	for (;;) {
		const rawIds = await prompter.input("Enter allowed Telegram chat/user IDs separated by commas:");
		try {
			const ids = parseIdList(rawIds);
			if (ids.length === 0) {
				prompter.warn("Enter at least one Telegram ID.");
				continue;
			}
			return {
				chatIds: ids,
				userIds: ids.filter((id) => id > 0),
				offset: await client.getLatestOffset(token),
			};
		} catch (error) {
			prompter.warn(error instanceof Error ? error.message : String(error));
		}
	}
}

export async function setupTelegramBridge(options: TelegramBridgeSetupOptions): Promise<TelegramBridgeSetupResult> {
	const agentDir = options.agentDir ?? getAgentDir();
	const client = options.client ?? new DefaultTelegramBridgeClient();
	const targetDir = getInstalledTelegramBridgeDir(agentDir);
	const configPath = join(targetDir, "config.json");
	const statePath = join(targetDir, "state.json");
	const dataDir = join(agentDir, TELEGRAM_BRIDGE_ID);

	const existingConfig = readExistingConfig(configPath);
	if (existingConfig && !options.force) {
		const replace = await options.prompter.confirm("Telegram bridge is already configured. Replace it?", false);
		if (!replace) {
			return {
				status: "ready",
				messages: [`Telegram bridge already configured: ${targetDir}`],
			};
		}
	}

	const copyError = copyBridgeTemplate(targetDir, existingConfig ? true : (options.force ?? false));
	if (copyError) {
		return { status: "pending", messages: [copyError] };
	}

	const token = await options.prompter.input("Paste Telegram bot token:");
	let bot: TelegramBotIdentity;
	try {
		bot = await client.validateBot(token);
		await client.clearWebhook(token);
	} catch (error) {
		return {
			status: "pending",
			messages: [`Telegram bot validation failed: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	const allowlist = await collectAllowlist(options.prompter, client, token);
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	mkdirSync(join(dataDir, "downloads"), { recursive: true, mode: 0o700 });

	writeConfig(configPath, {
		enabled: true,
		botToken: token,
		botUsername: bot.username,
		allowedChatIds: allowlist.chatIds,
		allowedUserIds: allowlist.userIds,
		dataDir,
		pollTimeoutSeconds: 25,
	});
	writeState(statePath, { offset: allowlist.offset, paused: false });

	return {
		status: "ready",
		messages: [
			`Telegram bridge installed: ${targetDir}`,
			"Telegram bridge is editable by Morgan. Edit its files and run /reload to apply changes.",
		],
	};
}
