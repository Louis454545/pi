import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBundledExtensionsDir } from "../src/config.ts";
import type { ExtensionContext, TriggerContext } from "../src/core/extensions/types.ts";
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
		vi.useRealTimers();
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
		return (await loadBridge()).extension;
	}

	async function loadBridge() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();
		const extensions = loader.getExtensions();
		const extension = extensions.extensions.find((candidate) => candidate.path === join(bridgeDir, "index.ts"));
		expect(extension).toBeDefined();
		return { extension: extension!, runtime: extensions.runtime };
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

	it("steers authorized inbound messages in Telegram update order", async () => {
		writeBridgeConfig([123]);
		const controller = new AbortController();
		const deliveries: Array<{
			content: string | unknown[];
			options: { deliverAs?: "steer" | "followUp" } | undefined;
		}> = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method, body: init?.body });
			const url = String(input);
			const result = url.endsWith("/getUpdates")
				? [
						{
							update_id: 10,
							message: { message_id: 1, chat: { id: 123 }, from: { id: 123 }, text: "first" },
						},
						{
							update_id: 11,
							message: { message_id: 2, chat: { id: 123 }, from: { id: 123 }, text: "second" },
						},
					]
				: true;
			return new Response(JSON.stringify({ ok: true, result }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const { extension, runtime } = await loadBridge();
		runtime.sendUserMessage = (content, options) => {
			deliveries.push({ content, options });
			if (deliveries.length === 2) {
				controller.abort();
			}
		};
		const trigger = extension.triggers.get("telegram-bridge");
		expect(trigger).toBeDefined();
		const cleanup = await trigger?.definition.start?.(
			{
				...createContext(),
				triggerName: "telegram-bridge",
				signal: controller.signal,
				exec: async () => ({
					stdout: "",
					stderr: "",
					code: 0,
					killed: false,
					truncated: false,
					stdoutTruncated: false,
					stderrTruncated: false,
				}),
			} as TriggerContext,
			() => {},
		);

		await vi.waitFor(() => expect(deliveries).toHaveLength(2));
		await cleanup?.();

		expect(deliveries.map((delivery) => delivery.options)).toEqual([{ deliverAs: "steer" }, { deliverAs: "steer" }]);
		expect(deliveries.map((delivery) => delivery.content)).toEqual([
			expect.stringContaining("first"),
			expect.stringContaining("second"),
		]);
	});

	it("keeps repeated polling errors in the footer and clears the error after recovery", async () => {
		vi.useFakeTimers();
		writeBridgeConfig([123]);
		const controller = new AbortController();
		const statuses: Array<string | undefined> = [];
		const notifications: string[] = [];
		let getUpdatesCalls = 0;
		const ui = {
			...createContext().ui,
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, text: string | undefined) => {
				statuses.push(text);
				if (statuses.filter((status) => status === "Telegram polling").length === 2) {
					controller.abort();
				}
			},
		};
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/getUpdates")) {
				getUpdatesCalls++;
				if (getUpdatesCalls <= 2) {
					return new Response(JSON.stringify({ ok: false, description: "connection lost" }), {
						status: 502,
						headers: { "content-type": "application/json" },
					});
				}
			}
			return new Response(JSON.stringify({ ok: true, result: url.endsWith("/getUpdates") ? [] : true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const { extension } = await loadBridge();
		const trigger = extension.triggers.get("telegram-bridge");
		expect(trigger).toBeDefined();
		const cleanup = await trigger?.definition.start?.(
			{
				...createContext(),
				triggerName: "telegram-bridge",
				signal: controller.signal,
				hasUI: true,
				ui,
				exec: async () => ({
					stdout: "",
					stderr: "",
					code: 0,
					killed: false,
					truncated: false,
					stdoutTruncated: false,
					stderrTruncated: false,
				}),
			} as TriggerContext,
			() => {},
		);

		await vi.advanceTimersByTimeAsync(6000);
		await cleanup?.();

		expect(notifications).toEqual([]);
		expect(statuses).toEqual([
			"Telegram polling",
			"Telegram error: connection lost",
			"Telegram error: connection lost",
			"Telegram polling",
			undefined,
			undefined,
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
