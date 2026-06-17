import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");
const STATE_PATH = join(EXTENSION_DIR, "state.json");
const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;

const SEND_MESSAGE_PARAMS = Type.Object({
	integration: Type.Literal("telegram", { description: "Message integration to use" }),
	chatId: Type.Optional(Type.Number({ description: "Telegram chat id to send to" })),
	message: Type.Optional(Type.String({ description: "Text message to send" })),
	attachments: Type.Optional(
		Type.Array(Type.String({ description: "Local file path to send as a Telegram document" }), {
			description: "Local file paths to send as Telegram documents",
		}),
	),
});

type SendMessageParams = Static<typeof SEND_MESSAGE_PARAMS>;

interface MorganApi {
	registerTrigger(trigger: {
		name: string;
		description?: string;
		start(ctx: TriggerContext, emit: (event: TriggerEventInput) => void): undefined | (() => void);
	}): void;
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
	): void;
	registerTool<TParams>(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: TParams;
		execute(
			toolCallId: string,
			params: TParams extends typeof SEND_MESSAGE_PARAMS ? SendMessageParams : never,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: Record<string, unknown>;
		}>;
	}): void;
	sendUserMessage(content: string, options?: { deliverAs?: "followUp" | "steer" }): void;
}

interface ExtensionUI {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

interface ExtensionContext {
	ui: ExtensionUI;
	hasUI: boolean;
	cwd: string;
	isIdle(): boolean;
}

interface ExtensionCommandContext extends ExtensionContext {
	reload(): Promise<void>;
}

interface TriggerContext extends ExtensionContext {
	signal: AbortSignal;
}

interface TriggerEventInput {
	eventId?: string;
	summary: string;
	payload?: unknown;
	createdAt?: string;
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

interface TelegramApiResponse<T> {
	ok?: boolean;
	result?: T;
	description?: string;
}

interface TelegramUser {
	id?: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
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

interface TelegramFileRef {
	file_id?: string;
	file_name?: string;
	mime_type?: string;
}

interface TelegramPhotoSize {
	file_id?: string;
	file_size?: number;
	width?: number;
	height?: number;
}

interface TelegramLocation {
	latitude?: number;
	longitude?: number;
}

interface TelegramContact {
	phone_number?: string;
	first_name?: string;
	last_name?: string;
	user_id?: number;
}

interface TelegramPoll {
	id?: string;
	question?: string;
}

interface TelegramMessage {
	message_id?: number;
	date?: number;
	from?: TelegramUser;
	chat?: TelegramChat;
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramFileRef;
	audio?: TelegramFileRef;
	voice?: TelegramFileRef;
	video?: TelegramFileRef;
	video_note?: TelegramFileRef;
	animation?: TelegramFileRef;
	sticker?: TelegramFileRef;
	location?: TelegramLocation;
	contact?: TelegramContact;
	poll?: TelegramPoll;
}

interface TelegramUpdate {
	update_id?: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramFile {
	file_id?: string;
	file_path?: string;
}

function loadConfig(): TelegramBridgeConfig {
	return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as TelegramBridgeConfig;
}

function loadState(): TelegramBridgeState {
	if (!existsSync(STATE_PATH)) {
		return { offset: 0, paused: false };
	}
	return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as TelegramBridgeState;
}

function saveState(state: TelegramBridgeState): void {
	writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

async function callTelegramApi<T>(
	config: TelegramBridgeConfig,
	method: string,
	body: Record<string, unknown>,
): Promise<T> {
	const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
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

async function callTelegramForm<T>(config: TelegramBridgeConfig, method: string, form: FormData): Promise<T> {
	const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
		method: "POST",
		body: form,
	});
	const payload = (await response.json()) as TelegramApiResponse<T>;
	if (!response.ok || !payload.ok || payload.result === undefined) {
		throw new Error(payload.description ?? `Telegram ${method} failed with HTTP ${response.status}.`);
	}
	return payload.result;
}

async function sendTelegramMessage(config: TelegramBridgeConfig, chatId: number, text: string): Promise<void> {
	for (const chunk of splitTelegramText(text)) {
		await callTelegramApi<unknown>(config, "sendMessage", {
			chat_id: chatId,
			text: chunk,
			disable_web_page_preview: true,
		});
	}
}

async function sendTelegramDocument(config: TelegramBridgeConfig, chatId: number, path: string): Promise<void> {
	const form = new FormData();
	const bytes = new Uint8Array(readFileSync(path));
	form.set("chat_id", String(chatId));
	form.set("document", new Blob([bytes]), basename(path));
	await callTelegramForm<unknown>(config, "sendDocument", form);
}

async function getUpdates(config: TelegramBridgeConfig, state: TelegramBridgeState): Promise<TelegramUpdate[]> {
	return await callTelegramApi<TelegramUpdate[]>(config, "getUpdates", {
		offset: state.offset,
		timeout: config.pollTimeoutSeconds,
		allowed_updates: ["message", "edited_message"],
	});
}

async function clearWebhook(config: TelegramBridgeConfig): Promise<void> {
	await callTelegramApi<true>(config, "deleteWebhook", { drop_pending_updates: false });
}

function sanitizeFileName(name: string): string {
	return (
		basename(name)
			.replace(/[^a-zA-Z0-9._-]/g, "_")
			.slice(0, 120) || "telegram-file"
	);
}

function splitTelegramText(text: string): string[] {
	if (text.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
		return [text];
	}
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
		let index = rest.lastIndexOf("\n", MAX_TELEGRAM_MESSAGE_LENGTH);
		if (index < 1000) {
			index = MAX_TELEGRAM_MESSAGE_LENGTH;
		}
		chunks.push(rest.slice(0, index));
		rest = rest.slice(index).trimStart();
	}
	if (rest) {
		chunks.push(rest);
	}
	return chunks;
}

function getDownloadDir(config: TelegramBridgeConfig, message: TelegramMessage): string {
	const date = new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString().slice(0, 10);
	const chatId = message.chat?.id ?? "unknown";
	const dir = join(config.dataDir, "downloads", date, String(chatId));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

async function downloadTelegramFile(
	config: TelegramBridgeConfig,
	message: TelegramMessage,
	fileId: string,
	name: string,
): Promise<string> {
	const file = await callTelegramApi<TelegramFile>(config, "getFile", { file_id: fileId });
	if (!file.file_path) {
		throw new Error("Telegram did not return a file path.");
	}
	const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
	if (!response.ok) {
		throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
	}
	const targetPath = join(getDownloadDir(config, message), sanitizeFileName(name));
	const bytes = new Uint8Array(await response.arrayBuffer());
	writeFileSync(targetPath, bytes, { mode: 0o600 });
	return targetPath;
}

function chooseLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
	return photos
		.slice()
		.sort((a, b) => (b.file_size ?? b.width ?? 0) - (a.file_size ?? a.width ?? 0))
		.at(0);
}

function addFileRef(
	refs: Array<{ kind: string; ref: TelegramFileRef; defaultName: string }>,
	kind: string,
	ref: TelegramFileRef | undefined,
	defaultName: string,
): void {
	if (ref?.file_id) {
		refs.push({ kind, ref, defaultName });
	}
}

async function describeTelegramMessage(config: TelegramBridgeConfig, message: TelegramMessage): Promise<string> {
	const lines: string[] = [];
	const chat = message.chat;
	const from = message.from;
	const chatId = chat?.id;

	lines.push("Telegram message received.");
	lines.push(`Chat: ${formatChat(chat)}`);
	if (chatId !== undefined) {
		if (config.allowedChatIds.includes(chatId)) {
			lines.push(`Reply with the send_message tool using integration "telegram" and chatId ${chatId}.`);
		} else {
			lines.push(`This chat id is ${chatId}, but outbound replies require it in allowedChatIds.`);
		}
	}
	if (from) {
		lines.push(`From: ${formatUser(from)}`);
	}
	if (message.text) {
		lines.push("");
		lines.push(message.text);
	}
	if (message.caption) {
		lines.push("");
		lines.push(`Caption: ${message.caption}`);
	}

	const refs: Array<{ kind: string; ref: TelegramFileRef; defaultName: string }> = [];
	const photo = message.photo ? chooseLargestPhoto(message.photo) : undefined;
	if (photo?.file_id) {
		refs.push({
			kind: "photo",
			ref: { file_id: photo.file_id },
			defaultName: `photo-${message.message_id ?? Date.now()}.jpg`,
		});
	}
	addFileRef(
		refs,
		"document",
		message.document,
		message.document?.file_name ?? `document-${message.message_id ?? Date.now()}`,
	);
	addFileRef(refs, "audio", message.audio, message.audio?.file_name ?? `audio-${message.message_id ?? Date.now()}`);
	addFileRef(refs, "voice", message.voice, `voice-${message.message_id ?? Date.now()}.ogg`);
	addFileRef(refs, "video", message.video, message.video?.file_name ?? `video-${message.message_id ?? Date.now()}`);
	addFileRef(refs, "video_note", message.video_note, `video-note-${message.message_id ?? Date.now()}.mp4`);
	addFileRef(
		refs,
		"animation",
		message.animation,
		message.animation?.file_name ?? `animation-${message.message_id ?? Date.now()}`,
	);
	addFileRef(refs, "sticker", message.sticker, `sticker-${message.message_id ?? Date.now()}`);

	for (const { kind, ref, defaultName } of refs) {
		try {
			const downloadedPath = await downloadTelegramFile(
				config,
				message,
				ref.file_id ?? "",
				ref.file_name ?? defaultName,
			);
			lines.push(`${kind} file: ${downloadedPath}`);
		} catch (error) {
			lines.push(`${kind} file download failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (message.location) {
		lines.push(`Location: ${message.location.latitude ?? "?"}, ${message.location.longitude ?? "?"}`);
	}
	if (message.contact) {
		lines.push(
			`Contact: ${[message.contact.first_name, message.contact.last_name].filter(Boolean).join(" ") || "unknown"} ${message.contact.phone_number ?? ""}`.trim(),
		);
	}
	if (message.poll) {
		lines.push(`Poll: ${message.poll.question ?? message.poll.id ?? "unknown"}`);
	}

	return lines.join("\n");
}

function formatChat(chat: TelegramChat | undefined): string {
	if (!chat) {
		return "unknown";
	}
	const name = chat.title ?? chat.username ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ");
	return name ? `${name} (${chat.id ?? "unknown"})` : String(chat.id ?? "unknown");
}

function formatUser(user: TelegramUser): string {
	const name = user.username ?? [user.first_name, user.last_name].filter(Boolean).join(" ");
	return name ? `${name} (${user.id ?? "unknown"})` : String(user.id ?? "unknown");
}

function isAuthorized(config: TelegramBridgeConfig, message: TelegramMessage): boolean {
	const chatId = message.chat?.id;
	const userId = message.from?.id;
	return (
		(chatId !== undefined && config.allowedChatIds.includes(chatId)) ||
		(userId !== undefined && config.allowedUserIds.includes(userId))
	);
}

function parseTelegramId(raw: string): number | undefined {
	const value = Number.parseInt(raw.trim(), 10);
	return Number.isSafeInteger(value) ? value : undefined;
}

function addAllowedId(config: TelegramBridgeConfig, id: number): void {
	if (!config.allowedChatIds.includes(id)) {
		config.allowedChatIds.push(id);
	}
	if (id > 0 && !config.allowedUserIds.includes(id)) {
		config.allowedUserIds.push(id);
	}
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

function resolveOutboundChatId(config: TelegramBridgeConfig, chatId: number | undefined): number {
	if (chatId !== undefined) {
		if (!config.allowedChatIds.includes(chatId)) {
			throw new Error(`Telegram chat ${chatId} is not allowed for outbound messages.`);
		}
		return chatId;
	}
	if (config.allowedChatIds.length === 1) {
		return config.allowedChatIds[0];
	}
	throw new Error("Telegram chatId is required when zero or multiple outbound chats are allowed.");
}

function resolveAttachmentPath(cwd: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		throw new Error("Telegram attachment paths must not be empty.");
	}
	const absolutePath = resolve(cwd, trimmed);
	if (!existsSync(absolutePath)) {
		throw new Error(`Telegram attachment does not exist: ${absolutePath}`);
	}
	return absolutePath;
}

async function sendOutboundMessage(
	config: TelegramBridgeConfig,
	params: SendMessageParams,
	cwd: string,
): Promise<{
	chatId: number;
	messageSent: boolean;
	attachments: string[];
}> {
	const chatId = resolveOutboundChatId(config, params.chatId);
	const text = params.message?.trim();
	const attachments = (params.attachments ?? []).map((path) => resolveAttachmentPath(cwd, path));
	if (!text && attachments.length === 0) {
		throw new Error("Telegram send_message requires message text or at least one attachment.");
	}

	if (text) {
		await sendTelegramMessage(config, chatId, text);
	}
	for (const path of attachments) {
		await sendTelegramDocument(config, chatId, path);
	}

	return { chatId, messageSent: !!text, attachments };
}

function isStaleRuntimeError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

export default function telegramBridge(morgan: MorganApi) {
	morgan.registerTrigger({
		name: "telegram-bridge",
		description: "Receive Telegram bot messages and forward them to Morgan.",
		start(ctx, _emit) {
			const ui = ctx.ui;
			const hasUI = ctx.hasUI;
			const signal = ctx.signal;
			let stopped = false;
			const isStopped = () => stopped || signal.aborted;
			const setStatus = (text: string | undefined): void => {
				try {
					ui.setStatus("telegram-bridge", text);
				} catch {
					// Ignore UI teardown races during session replacement.
				}
			};

			const run = async (): Promise<void> => {
				let config = loadConfig();
				let state = loadState();
				if (!config.enabled) {
					setStatus("Telegram disabled");
					return;
				}

				mkdirSync(join(config.dataDir, "downloads"), { recursive: true, mode: 0o700 });
				await clearWebhook(config);
				if (isStopped()) {
					return;
				}
				setStatus("Telegram polling");

				while (!isStopped()) {
					config = loadConfig();
					state = loadState();
					if (state.paused || !config.enabled) {
						setStatus(state.paused ? "Telegram paused" : "Telegram disabled");
						await sleep(1000, signal);
						continue;
					}

					try {
						const updates = await getUpdates(config, state);
						if (isStopped()) {
							return;
						}
						for (const update of updates) {
							if (typeof update.update_id === "number") {
								state.offset = Math.max(state.offset, update.update_id + 1);
								saveState(state);
							}

							const message = update.message ?? update.edited_message;
							if (!message?.chat?.id || !isAuthorized(config, message)) {
								continue;
							}

							const prompt = await describeTelegramMessage(config, message);
							if (isStopped()) {
								return;
							}
							try {
								morgan.sendUserMessage(prompt, { deliverAs: "followUp" });
							} catch (error) {
								if (!isStaleRuntimeError(error)) {
									throw error;
								}
								return;
							}
						}
					} catch (error) {
						if (isStopped() || isStaleRuntimeError(error)) {
							return;
						}
						setStatus("Telegram error");
						if (hasUI) {
							ui.notify(
								`Telegram bridge error: ${error instanceof Error ? error.message : String(error)}`,
								"warning",
							);
						}
						await sleep(3000, signal);
					}
				}
			};

			void run().catch((error: unknown) => {
				if (isStopped() || isStaleRuntimeError(error)) {
					return;
				}
				setStatus("Telegram error");
				if (hasUI) {
					ui.notify(`Telegram bridge error: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			});
			signal.addEventListener(
				"abort",
				() => {
					stopped = true;
					setStatus(undefined);
				},
				{ once: true },
			);
			return () => {
				stopped = true;
				setStatus(undefined);
			};
		},
	});

	morgan.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: (_args, ctx) => {
			const config = loadConfig();
			const state = loadState();
			ctx.ui.notify(
				`Telegram ${config.enabled ? "enabled" : "disabled"}, ${state.paused ? "paused" : "running"}, ${config.allowedChatIds.length} allowed chats`,
				"info",
			);
		},
	});

	morgan.registerCommand("telegram-pause", {
		description: "Pause Telegram polling",
		handler: (_args, ctx) => {
			const state = loadState();
			saveState({ ...state, paused: true });
			ctx.ui.notify("Telegram bridge paused. Run /reload or wait for the next poll cycle.", "info");
		},
	});

	morgan.registerCommand("telegram-resume", {
		description: "Resume Telegram polling",
		handler: (_args, ctx) => {
			const state = loadState();
			saveState({ ...state, paused: false });
			ctx.ui.notify("Telegram bridge resumed.", "info");
		},
	});

	morgan.registerCommand("telegram-allow", {
		description: "Allow a Telegram chat/user id",
		handler: (args, ctx) => {
			const id = parseTelegramId(args);
			if (id === undefined) {
				ctx.ui.notify("Usage: /telegram-allow <chat_or_user_id>", "warning");
				return;
			}
			addAllowedId(loadConfig(), id);
			ctx.ui.notify(`Allowed Telegram id ${id}.`, "info");
		},
	});

	morgan.registerTool({
		name: "send_message",
		label: "Send Message",
		description: "Send text and local file attachments through a configured messaging integration.",
		promptSnippet: "Send messages through configured integrations such as Telegram",
		promptGuidelines: [
			'Use send_message with integration "telegram" to reply to Telegram messages; final assistant text is not sent to Telegram automatically.',
			"When replying to a Telegram message, pass the chatId shown in the Telegram message prompt unless there is exactly one allowed Telegram chat.",
		],
		parameters: SEND_MESSAGE_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await sendOutboundMessage(loadConfig(), params, ctx.cwd);
			return {
				content: [{ type: "text", text: "Telegram message sent." }],
				details: result,
			};
		},
	});
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
