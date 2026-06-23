import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBundledExtensionsDir } from "../src/config.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface TelegramFetchCall {
	url: string;
	method: string | undefined;
	body: unknown;
}

describe("telegram bridge extension", () => {
	let tempDir: string;
	let agentDir: string;
	let bridgeDir: string;
	let calls: TelegramFetchCall[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "morgan-telegram-bridge-"));
		agentDir = join(tempDir, "agent");
		bridgeDir = join(agentDir, "extensions", "triggers", "telegram-bridge");
		calls = [];
		mkdirSync(agentDir, { recursive: true });
		cpSync(join(getBundledExtensionsDir(), "telegram-bridge"), bridgeDir, { recursive: true });
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method, body: init?.body });
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function writeBridgeConfig(allowedChatIds: number[]): void {
		const dataDir = join(agentDir, "telegram-bridge");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			join(bridgeDir, "config.json"),
			`${JSON.stringify(
				{
					enabled: true,
					botToken: "123456:token",
					botUsername: "morgan_test_bot",
					allowedChatIds,
					allowedUserIds: [],
					dataDir,
					pollTimeoutSeconds: 25,
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf-8", mode: 0o600 },
		);
		writeFileSync(join(bridgeDir, "state.json"), `${JSON.stringify({ offset: 0, paused: false }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	}

	async function loadBridgeExtension() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();
		const extension = loader
			.getExtensions()
			.extensions.find((candidate) => candidate.path === join(bridgeDir, "index.ts"));
		expect(extension).toBeDefined();
		return extension!;
	}

	async function loadSendMessageTool() {
		const extension = await loadBridgeExtension();
		const tool = extension.tools.get("send_message");
		expect(tool).toBeDefined();
		return tool!;
	}

	function createContext(): ExtensionContext {
		return { cwd: tempDir } as ExtensionContext;
	}

	function parseJsonBody(call: TelegramFetchCall): Record<string, unknown> {
		expect(typeof call.body).toBe("string");
		return JSON.parse(call.body as string) as Record<string, unknown>;
	}

	it("registers send_message without the old file tool or automatic message forwarding", async () => {
		writeBridgeConfig([123]);
		const extension = await loadBridgeExtension();

		expect(extension.tools.has("send_message")).toBe(true);
		expect(extension.tools.has("telegram_send_file")).toBe(false);
		expect(extension.handlers.has("message_end")).toBe(false);
		expect(extension.tools.get("send_message")?.definition.promptGuidelines).toEqual([
			'Use send_message with integration "telegram" to reply to Telegram messages; final assistant text is not sent to Telegram automatically.',
			"When replying to a Telegram message, pass the chatId shown in the Telegram message prompt unless there is exactly one allowed Telegram chat.",
		]);
	});

	it("sends text to an explicit allowed Telegram chat", async () => {
		writeBridgeConfig([123, 456]);
		const tool = await loadSendMessageTool();

		const result = await tool.definition.execute(
			"tool-1",
			{ integration: "telegram", chatId: 456, message: "hello" },
			undefined,
			undefined,
			createContext(),
		);

		expect(result.content).toEqual([{ type: "text", text: "Telegram message sent." }]);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.telegram.org/bot123456:token/sendMessage");
		expect(parseJsonBody(calls[0])).toMatchObject({
			chat_id: 456,
			text: "hello",
			disable_web_page_preview: true,
		});
	});

	it("defaults chatId only when exactly one outbound chat is allowed", async () => {
		writeBridgeConfig([123]);
		const tool = await loadSendMessageTool();

		await tool.definition.execute(
			"tool-1",
			{ integration: "telegram", message: "default target" },
			undefined,
			undefined,
			createContext(),
		);

		expect(parseJsonBody(calls[0])).toMatchObject({ chat_id: 123, text: "default target" });
	});

	it("sends attachments as Telegram documents", async () => {
		writeBridgeConfig([123]);
		const attachmentPath = join(tempDir, "report.txt");
		writeFileSync(attachmentPath, "report", "utf-8");
		const tool = await loadSendMessageTool();

		await tool.definition.execute(
			"tool-1",
			{ integration: "telegram", chatId: 123, attachments: ["report.txt"] },
			undefined,
			undefined,
			createContext(),
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.telegram.org/bot123456:token/sendDocument");
		expect(calls[0].body).toBeInstanceOf(FormData);
		const form = calls[0].body as FormData;
		expect(form.get("chat_id")).toBe("123");
		expect(form.get("document")).toBeInstanceOf(Blob);
	});

	it("requires chatId when multiple outbound chats are allowed", async () => {
		writeBridgeConfig([123, 456]);
		const tool = await loadSendMessageTool();

		await expect(
			tool.definition.execute(
				"tool-1",
				{ integration: "telegram", message: "ambiguous" },
				undefined,
				undefined,
				createContext(),
			),
		).rejects.toThrow("Telegram chatId is required when zero or multiple outbound chats are allowed.");
		expect(calls).toHaveLength(0);
	});

	it("rejects outbound chats that are not allowlisted", async () => {
		writeBridgeConfig([123]);
		const tool = await loadSendMessageTool();

		await expect(
			tool.definition.execute(
				"tool-1",
				{ integration: "telegram", chatId: 999, message: "blocked" },
				undefined,
				undefined,
				createContext(),
			),
		).rejects.toThrow("Telegram chat 999 is not allowed for outbound messages.");
		expect(calls).toHaveLength(0);
	});

	it("requires text or at least one attachment", async () => {
		writeBridgeConfig([123]);
		const tool = await loadSendMessageTool();

		await expect(
			tool.definition.execute(
				"tool-1",
				{ integration: "telegram", chatId: 123, message: "   ", attachments: [] },
				undefined,
				undefined,
				createContext(),
			),
		).rejects.toThrow("Telegram send_message requires message text or at least one attachment.");
		expect(calls).toHaveLength(0);
	});
});
