import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/morgan-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/morgan-ai";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Loader,
	Markdown,
	type MarkdownTheme,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/morgan-tui";
import { APP_NAME, APP_TITLE, getAgentDir, VERSION } from "../config.ts";
import { type AgentSessionEvent, parseSkillBlock, type SessionStats } from "../core/agent-session.ts";
import type { BashResult } from "../core/bash-executor.ts";
import { FooterDataProvider } from "../core/footer-data-provider.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { createCompactionSummaryMessage } from "../core/messages.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import type { TruncationResult } from "../core/tools/truncate.ts";
import { AssistantMessageComponent } from "../modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../modes/interactive/components/compaction-summary-message.ts";
import { CustomEditor } from "../modes/interactive/components/custom-editor.ts";
import { CustomMessageComponent } from "../modes/interactive/components/custom-message.ts";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { ExtensionEditorComponent } from "../modes/interactive/components/extension-editor.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import { keyText, rawKeyHint } from "../modes/interactive/components/keybinding-hints.ts";
import { SkillInvocationMessageComponent } from "../modes/interactive/components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../modes/interactive/components/user-message.ts";
import {
	getEditorTheme,
	getMarkdownTheme,
	initTheme,
	onThemeChange,
	stopThemeWatcher,
	theme,
} from "../modes/interactive/theme/theme.ts";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "../modes/rpc/rpc-types.ts";
import { copyToClipboard } from "../utils/clipboard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { DaemonClient } from "./client.ts";

type DaemonModelInfo = Awaited<ReturnType<DaemonClient["getAvailableModels"]>>[number];
type QueuedMessage = { text: string; mode: "steer" | "followUp" };
type ToolResultContentBlock = { type: string; text?: string; data?: string; mimeType?: string };
type ToolResultPayload = {
	content: ToolResultContentBlock[];
	details?: unknown;
	isError: boolean;
};

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);
const BUILT_IN_COMMANDS: Array<{ name: string; description: string }> = [
	{ name: "quit", description: "Exit daemon attach" },
	{ name: "reset", description: "Archive and reset the global conversation" },
	{ name: "compact", description: "Compact daemon conversation context" },
	{ name: "session", description: "Show daemon conversation information" },
	{ name: "name", description: "Set daemon conversation name" },
	{ name: "export", description: "Export daemon conversation to HTML" },
	{ name: "copy", description: "Copy last assistant response" },
	{ name: "model", description: "Select or set daemon model" },
	{ name: "reload", description: "Reload daemon resources" },
	{ name: "hotkeys", description: "Show daemon attach shortcuts" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isDeadTerminalError(error: unknown): boolean {
	if (!isRecord(error)) {
		return false;
	}
	const code = typeof error.code === "string" ? error.code : undefined;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

function getRecordType(value: unknown): string | undefined {
	return isRecord(value) && typeof value.type === "string" ? value.type : undefined;
}

function isToolResultContentBlock(value: unknown): value is ToolResultContentBlock {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	return (
		(value.text === undefined || typeof value.text === "string") &&
		(value.data === undefined || typeof value.data === "string") &&
		(value.mimeType === undefined || typeof value.mimeType === "string")
	);
}

function toToolResultPayload(value: unknown, isError: boolean): ToolResultPayload | undefined {
	if (!isRecord(value) || !Array.isArray(value.content) || !value.content.every(isToolResultContentBlock)) {
		return undefined;
	}
	const result: ToolResultPayload = { content: value.content, isError };
	if ("details" in value) {
		result.details = value.details;
	}
	return result;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function getUserMessageText(message: Message): string {
	if (message.role !== "user") return "";
	const textBlocks =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.filter((content: { type: string }) => content.type === "text");
	return textBlocks.map((content) => (content as { text: string }).text).join("");
}

function getPathCommandArgument(text: string, command: "/export"): string | undefined {
	if (text === command) {
		return undefined;
	}
	if (!text.startsWith(`${command} `)) {
		return undefined;
	}
	const argsString = text.slice(command.length + 1).trimStart();
	if (!argsString) {
		return undefined;
	}
	const firstChar = argsString[0];
	if (firstChar === '"' || firstChar === "'") {
		const closingQuoteIndex = argsString.indexOf(firstChar, 1);
		return closingQuoteIndex < 0 ? undefined : argsString.slice(1, closingQuoteIndex);
	}
	const firstWhitespaceIndex = argsString.search(/\s/);
	return firstWhitespaceIndex < 0 ? argsString : argsString.slice(0, firstWhitespaceIndex);
}

export function parseDaemonModelQuery(query: string): { provider: string; modelId: string } | undefined {
	const separatorIndex = query.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === query.length - 1) {
		return undefined;
	}
	return {
		provider: query.slice(0, separatorIndex),
		modelId: query.slice(separatorIndex + 1),
	};
}

export function getDaemonStreamingAssistantIndex(messages: AgentMessage[], isStreaming: boolean): number {
	if (!isStreaming) {
		return -1;
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") {
			return index;
		}
	}
	return -1;
}

export type DaemonEscapeAction = "abort_compaction" | "abort_retry" | "abort" | "abort_bash" | "clear";

export function getDaemonEscapeAction(
	state: Pick<RpcSessionState, "isCompacting" | "isStreaming"> | undefined,
	hasRetryLoader: boolean,
	hasBashComponent: boolean,
): DaemonEscapeAction {
	if (state?.isCompacting) {
		return "abort_compaction";
	}
	if (hasRetryLoader) {
		return "abort_retry";
	}
	if (state?.isStreaming) {
		return "abort";
	}
	if (hasBashComponent) {
		return "abort_bash";
	}
	return "clear";
}

class DaemonFooterComponent implements Component {
	private cwd: string;
	private footerData: FooterDataProvider;
	private state: RpcSessionState | undefined;
	private stats: SessionStats | undefined;
	private availableProviderCount = 0;

	constructor(cwd: string, footerData: FooterDataProvider) {
		this.cwd = cwd;
		this.footerData = footerData;
	}

	setCwd(cwd: string): void {
		this.cwd = cwd;
		this.footerData.setCwd(cwd);
	}

	setState(state: RpcSessionState | undefined): void {
		this.state = state;
	}

	setStats(stats: SessionStats | undefined): void {
		this.stats = stats;
	}

	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
		this.footerData.setAvailableProviderCount(count);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const branch = this.footerData.getGitBranch();
		const sessionName = this.state?.sessionName;
		let pwd = this.formatCwdForFooter();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}
		if (sessionName) {
			pwd = `${pwd} - ${sessionName}`;
		}

		const statsParts: string[] = [];
		const tokens = this.stats?.tokens;
		if (tokens) {
			if (tokens.input) statsParts.push(`in ${formatTokens(tokens.input)}`);
			if (tokens.output) statsParts.push(`out ${formatTokens(tokens.output)}`);
			if (tokens.cacheRead) statsParts.push(`read ${formatTokens(tokens.cacheRead)}`);
			if (tokens.cacheWrite) statsParts.push(`write ${formatTokens(tokens.cacheWrite)}`);
		}
		if (this.stats && this.stats.cost > 0) {
			statsParts.push(`$${this.stats.cost.toFixed(3)}`);
		}
		const contextUsage = this.stats?.contextUsage;
		const contextWindow = contextUsage?.contextWindow ?? this.state?.model?.contextWindow ?? 0;
		const contextPercent = contextUsage?.percent;
		const contextText =
			contextPercent === undefined
				? `?/${formatTokens(contextWindow)}`
				: contextPercent === null
					? `?/${formatTokens(contextWindow)}`
					: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
		if (contextWindow > 0) {
			statsParts.push(contextText);
		}

		let statsLeft = statsParts.join(" ");
		if (visibleWidth(statsLeft) > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
		}

		const model = this.state?.model;
		const modelName = model?.id ?? "no-model";
		let rightSide = modelName;
		if (model?.reasoning) {
			const thinkingLevel = this.state?.thinkingLevel ?? "off";
			rightSide = thinkingLevel === "off" ? `${modelName} - thinking off` : `${modelName} - ${thinkingLevel}`;
		}
		if (this.availableProviderCount > 1 && model) {
			rightSide = `(${model.provider}) ${rightSide}`;
		}

		const statsLeftWidth = visibleWidth(statsLeft);
		const rightSideWidth = visibleWidth(rightSide);
		const statsLine =
			statsLeftWidth + rightSideWidth + 2 <= width
				? statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide
				: `${statsLeft}  ${truncateToWidth(rightSide, Math.max(0, width - statsLeftWidth - 2), "")}`;

		const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), theme.fg("dim", statsLine)];
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const statusText = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) =>
					text
						.replace(/[\r\n\t]/g, " ")
						.replace(/ +/g, " ")
						.trim(),
				)
				.join(" ");
			lines.push(truncateToWidth(theme.fg("dim", statusText), width, theme.fg("dim", "...")));
		}
		return lines;
	}

	private formatCwdForFooter(): string {
		const home = process.env.HOME || process.env.USERPROFILE;
		if (!home) return this.cwd;
		const resolvedCwd = path.resolve(this.cwd);
		const resolvedHome = path.resolve(home);
		const relativeToHome = path.relative(resolvedHome, resolvedCwd);
		const insideHome =
			relativeToHome === "" ||
			(relativeToHome !== ".." && !relativeToHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToHome));
		if (!insideHome) return this.cwd;
		return relativeToHome === "" ? "~" : `~${path.sep}${relativeToHome}`;
	}
}

class DaemonModelSelectorComponent extends Container {
	private searchInput: Input;
	private listContainer: Container;
	private models: DaemonModelInfo[];
	private filteredModels: DaemonModelInfo[];
	private selectedIndex = 0;
	private onSelect: (model: DaemonModelInfo) => void;
	private onCancel: () => void;
	private tui: TUI;
	private currentModelId: string | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		models: DaemonModelInfo[],
		currentModelId: string | undefined,
		onSelect: (model: DaemonModelInfo) => void,
		onCancel: () => void,
		initialQuery?: string,
	) {
		super();
		this.tui = tui;
		this.models = [...models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
		this.filteredModels = this.models;
		this.currentModelId = currentModelId;
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", "Select model"), 1, 0));
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.onSelect(selected);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new DynamicBorder());
		if (initialQuery) {
			this.searchInput.setValue(initialQuery);
			this.filter(initialQuery);
		} else {
			this.updateList();
		}
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length > 0) {
				this.selectedIndex =
					this.selectedIndex === 0 ? this.filteredModels.length - 1 : Math.max(0, this.selectedIndex - 1);
				this.updateList();
			}
			return;
		}
		if (keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
				this.updateList();
			}
			return;
		}
		if (keybindings.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.onSelect(selected);
			}
			return;
		}
		if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.searchInput.handleInput(keyData);
		this.filter(this.searchInput.getValue());
	}

	private filter(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.models, query, (model) => `${model.provider}/${model.id} ${model.id} ${model.provider}`)
			: this.models;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);
		for (let index = startIndex; index < endIndex; index++) {
			const model = this.filteredModels[index];
			if (!model) continue;
			const selected = index === this.selectedIndex;
			const current = `${model.provider}/${model.id}` === this.currentModelId;
			const prefix = selected ? theme.fg("accent", "> ") : "  ";
			const label = selected ? theme.fg("accent", model.id) : model.id;
			const suffix = current ? theme.fg("success", " current") : "";
			this.listContainer.addChild(
				new Text(`${prefix}${label} ${theme.fg("muted", `[${model.provider}]`)}${suffix}`, 0, 0),
			);
		}
		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else if (startIndex > 0 || endIndex < this.filteredModels.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0),
			);
		}
		this.tui.requestRender();
	}
}

class DaemonInteractiveMode {
	private client: DaemonClient;
	private settingsManager: SettingsManager;
	private keybindings: KeybindingsManager;
	private ui: TUI;
	private headerContainer: Container;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private widgetContainer: Container;
	private editorContainer: Container;
	private editor: CustomEditor;
	private footerDataProvider: FooterDataProvider;
	private footer: DaemonFooterComponent;
	private cwd = process.cwd();
	private state: RpcSessionState | undefined;
	private stats: SessionStats | undefined;
	private availableModels: DaemonModelInfo[] = [];
	private daemonCommands: RpcSlashCommand[] = [];
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private streamingComponent: AssistantMessageComponent | undefined;
	private streamingMessage: AssistantMessage | undefined;
	private loadingAnimation: Loader | undefined;
	private compactionLoader: Loader | undefined;
	private retryLoader: Loader | undefined;
	private bashComponent: BashExecutionComponent | undefined;
	private isBashMode = false;
	private toolOutputExpanded = false;
	private hideThinkingBlock = false;
	private onInputCallback: ((text: string) => void) | undefined;
	private pendingUserInputs: string[] = [];
	private queuedMessages: QueuedMessage[] = [];
	private steeringMessages: string[] = [];
	private followUpMessages: string[] = [];
	private extensionWidgets = new Map<string, Component & { dispose?(): void }>();
	private extensionSelector: ExtensionSelectorComponent | undefined;
	private extensionInput: ExtensionInputComponent | undefined;
	private extensionEditor: ExtensionEditorComponent | undefined;
	private unsubscribeEvents: (() => void) | undefined;
	private signalCleanupHandlers: Array<() => void> = [];
	private initialized = false;
	private shuttingDown = false;
	private lastSigintTime = 0;
	private bufferedEvents: unknown[] = [];

	constructor(client: DaemonClient) {
		this.client = client;
		this.settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
		initTheme(this.settingsManager.getTheme(), true);
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainer = new Container();
		this.editorContainer = new Container();
		this.editor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: this.settingsManager.getEditorPaddingX(),
			autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
		});
		this.editorContainer.addChild(this.editor);
		this.footerDataProvider = new FooterDataProvider(this.cwd);
		this.footer = new DaemonFooterComponent(this.cwd, this.footerDataProvider);
	}

	async run(): Promise<void> {
		await this.client.connect();
		this.unsubscribeEvents = this.client.onEvent((event) => {
			if (!this.initialized) {
				this.bufferedEvents.push(event);
				return;
			}
			void this.handleEvent(event);
		});
		const status = await this.client.getStatus();
		this.cwd = status.cwd;
		this.footer.setCwd(this.cwd);
		await this.refreshState();
		await this.refreshCommands();
		this.setupUi(status.pid);
		await this.renderCurrentMessages();
		this.ui.start();
		this.initialized = true;
		this.updateTerminalTitle();
		for (const event of this.bufferedEvents.splice(0)) {
			await this.handleEvent(event);
		}

		while (true) {
			const userInput = await this.getUserInput();
			await this.sendUserInput(userInput, "steer");
		}
	}

	private setupUi(daemonPid: number): void {
		this.registerSignalHandlers();
		const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${VERSION} daemon pid ${daemonPid}`);
		const hints = [
			rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
			rawKeyHint("/", "commands"),
			rawKeyHint("!", "bash"),
			rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "model"),
			rawKeyHint(keyText("app.tools.expand"), "expand"),
		].join(theme.fg("muted", " - "));
		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(new Text(`${logo}\n${hints}`, 1, 0));
		this.headerContainer.addChild(new Spacer(1));

		this.ui.addChild(this.headerContainer);
		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.widgetContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);
		this.setupEditorHandlers();
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});
	}

	private setupEditorHandlers(): void {
		this.editor.onEscape = () => {
			switch (getDaemonEscapeAction(this.state, this.retryLoader !== undefined, this.bashComponent !== undefined)) {
				case "abort_compaction":
					void this.client.abortCompaction().catch((error: unknown) => this.showError(error));
					return;
				case "abort_retry":
					void this.client.abortRetry().catch((error: unknown) => this.showError(error));
					return;
				case "abort":
					void this.client.abort().catch((error: unknown) => this.showError(error));
					return;
				case "abort_bash":
					void this.client.abortBash().catch((error: unknown) => this.showError(error));
					return;
				case "clear":
					this.editor.setText("");
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
			}
		};
		this.editor.onCtrlD = () => {
			void this.shutdown();
		};
		this.editor.onAction("app.clear", () => this.handleCtrlC());
		this.editor.onAction("app.suspend", () => this.handleCtrlZ());
		this.editor.onAction("app.model.cycleForward", () => {
			void this.cycleModel("forward");
		});
		this.editor.onAction("app.model.cycleBackward", () => {
			void this.cycleModel("backward");
		});
		this.editor.onAction("app.thinking.cycle", () => {
			void this.cycleThinkingLevel();
		});
		this.editor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.editor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.editor.onAction("app.message.followUp", () => {
			void this.handleFollowUp();
		});
		this.editor.onAction("app.message.dequeue", () => this.restoreQueuedMessagesToEditor());
		this.editor.onAction("app.editor.external", () => {
			void this.openExternalEditor();
		});
		this.editor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};
		this.editor.onSubmit = async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			this.editor.setText("");
			this.editor.addToHistory?.(trimmed);
			await this.handleSubmittedText(trimmed);
		};
		this.updateEditorBorderColor();
	}

	private async refreshState(): Promise<void> {
		this.state = await this.client.getState();
		this.footer.setState(this.state);
		try {
			this.stats = await this.client.getSessionStats();
			this.footer.setStats(this.stats);
		} catch {
			this.stats = undefined;
			this.footer.setStats(undefined);
		}
		try {
			this.availableModels = await this.client.getAvailableModels();
			const providers = new Set(this.availableModels.map((model) => model.provider));
			this.footer.setAvailableProviderCount(providers.size);
		} catch {
			this.availableModels = [];
			this.footer.setAvailableProviderCount(0);
		}
		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	private async refreshCommands(): Promise<void> {
		try {
			this.daemonCommands = await this.client.getCommands();
		} catch {
			this.daemonCommands = [];
		}
		const commandNames = new Set(BUILT_IN_COMMANDS.map((command) => command.name));
		const commands = [...BUILT_IN_COMMANDS];
		for (const command of this.daemonCommands) {
			if (commandNames.has(command.name)) {
				continue;
			}
			commandNames.add(command.name);
			commands.push({ name: command.name, description: command.description ?? command.source });
		}
		const slashCommands = commands.map((command) => ({
			name: command.name,
			description: command.description,
			getArgumentCompletions:
				command.name === "model"
					? (prefix: string) =>
							fuzzyFilter(
								this.availableModels,
								prefix,
								(model) => `${model.provider}/${model.id} ${model.id}`,
							).map((model) => ({
								value: `${model.provider}/${model.id}`,
								label: model.id,
								description: model.provider,
							}))
					: undefined,
		}));
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, this.cwd));
	}

	private async renderCurrentMessages(): Promise<void> {
		const messages = await this.client.getMessages();
		this.chatContainer.clear();
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		const streamingAssistantIndex = getDaemonStreamingAssistantIndex(messages, this.state?.isStreaming === true);
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			if (!message) continue;
			if (message.role === "assistant") {
				const isStreamingAssistant = index === streamingAssistantIndex;
				if (isStreamingAssistant) {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
					);
					this.streamingMessage = message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
				} else {
					this.addMessageToChat(message);
				}
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = this.createToolComponent(content.name, content.id, content.arguments);
						if (!isStreamingAssistant) {
							component.setArgsComplete();
						}
						this.chatContainer.addChild(component);
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							component.updateResult({
								content: [{ type: "text", text: message.errorMessage ?? "Error" }],
								isError: true,
							});
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				this.addMessageToChat(message, { populateHistory: true });
			}
		}
		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const component = new CustomMessageComponent(message, undefined, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = getUserMessageText(message);
				if (!textContent) break;
				if (this.chatContainer.children.length > 0) {
					this.chatContainer.addChild(new Spacer(1));
				}
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					const component = new SkillInvocationMessageComponent(skillBlock, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					if (skillBlock.userMessage) {
						this.chatContainer.addChild(
							new UserMessageComponent(skillBlock.userMessage, this.getMarkdownThemeWithSettings()),
						);
					}
				} else {
					this.chatContainer.addChild(new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings()));
				}
				if (options?.populateHistory) {
					this.editor.addToHistory?.(textContent);
				}
				break;
			}
			case "assistant": {
				this.chatContainer.addChild(
					new AssistantMessageComponent(message, this.hideThinkingBlock, this.getMarkdownThemeWithSettings()),
				);
				break;
			}
			case "toolResult":
				break;
			default: {
				const _exhaustive: never = message;
				void _exhaustive;
				break;
			}
		}
	}

	private createToolComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{
				showImages: this.settingsManager.getShowImages(),
				imageWidthCells: this.settingsManager.getImageWidthCells(),
			},
			undefined,
			this.ui,
			this.cwd,
		);
		component.setExpanded(this.toolOutputExpanded);
		return component;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	private async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private async handleSubmittedText(text: string): Promise<void> {
		if (text === "/quit" || text === "/exit") {
			await this.shutdown();
			return;
		}
		if (text === "/reset") {
			await this.handleResetCommand();
			return;
		}
		if (text === "/compact" || text.startsWith("/compact ")) {
			await this.handleCompactCommand(text.startsWith("/compact ") ? text.slice(9).trim() : undefined);
			return;
		}
		if (text === "/reload") {
			await this.handleReloadCommand();
			return;
		}
		if (text === "/session") {
			await this.handleSessionCommand();
			return;
		}
		if (text === "/name" || text.startsWith("/name ")) {
			await this.handleNameCommand(text);
			return;
		}
		if (text === "/export" || text.startsWith("/export ")) {
			await this.handleExportCommand(text);
			return;
		}
		if (text === "/copy") {
			await this.handleCopyCommand();
			return;
		}
		if (text === "/model" || text.startsWith("/model ")) {
			await this.handleModelCommand(text.startsWith("/model ") ? text.slice(7).trim() : undefined);
			return;
		}
		if (text === "/hotkeys") {
			this.handleHotkeysCommand();
			return;
		}
		if (text === "/resume") {
			this.showWarning("/resume is deprecated; the global conversation is continued by default.");
			return;
		}
		if (text === "/settings" || text === "/tree") {
			this.showWarning(`${text} is not available through daemon attach yet`);
			return;
		}
		if (text === "/login" || text.startsWith("/login ") || text === "/logout" || text.startsWith("/logout ")) {
			this.showWarning("Login commands must run in a regular interactive morgan session");
			return;
		}
		if (text.startsWith("!")) {
			const excludeFromContext = text.startsWith("!!");
			const command = excludeFromContext ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				await this.handleBashCommand(command, excludeFromContext);
			}
			return;
		}
		if (this.state?.isCompacting) {
			this.queueCompactionMessage(text, "steer");
			return;
		}
		if (this.onInputCallback) {
			this.onInputCallback(text);
		} else {
			this.pendingUserInputs.push(text);
		}
	}

	private async sendUserInput(text: string, mode: "steer" | "followUp"): Promise<void> {
		try {
			if (this.state?.isStreaming) {
				if (mode === "followUp") {
					await this.client.followUp(text);
				} else {
					await this.client.steer(text);
				}
			} else {
				await this.client.prompt(text);
			}
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = this.editor.getText().trim();
		if (!text) return;
		this.editor.setText("");
		this.editor.addToHistory?.(text);
		if (this.state?.isCompacting) {
			this.queueCompactionMessage(text, "followUp");
			return;
		}
		if (this.state?.isStreaming) {
			await this.sendUserInput(text, "followUp");
			return;
		}
		await this.sendUserInput(text, "steer");
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.queuedMessages.push({ text, mode });
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private restoreQueuedMessagesToEditor(): void {
		const allQueued = [
			...this.steeringMessages,
			...this.followUpMessages,
			...this.queuedMessages.map((message) => message.text),
		];
		if (allQueued.length === 0) {
			this.showStatus("No queued messages to restore");
			return;
		}
		this.steeringMessages = [];
		this.followUpMessages = [];
		this.queuedMessages = [];
		const currentText = this.editor.getText();
		this.editor.setText([allQueued.join("\n\n"), currentText].filter((value) => value.trim()).join("\n\n"));
		this.updatePendingMessagesDisplay();
		this.showStatus(`Restored ${allQueued.length} queued message${allQueued.length > 1 ? "s" : ""} to editor`);
	}

	private async flushCompactionQueue(): Promise<void> {
		if (this.queuedMessages.length === 0) {
			return;
		}
		const queuedMessages = [...this.queuedMessages];
		this.queuedMessages = [];
		this.updatePendingMessagesDisplay();
		for (let index = 0; index < queuedMessages.length; index++) {
			const message = queuedMessages[index];
			if (!message) continue;
			try {
				if (index === 0 && !this.state?.isStreaming) {
					await this.client.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.client.followUp(message.text);
				} else {
					await this.client.steer(message.text);
				}
			} catch (error: unknown) {
				this.queuedMessages.unshift(...queuedMessages.slice(index));
				this.showError(error);
				this.updatePendingMessagesDisplay();
				return;
			}
		}
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const steering = [
			...this.steeringMessages,
			...this.queuedMessages.filter((message) => message.mode === "steer").map((message) => message.text),
		];
		const followUp = [
			...this.followUpMessages,
			...this.queuedMessages.filter((message) => message.mode === "followUp").map((message) => message.text),
		];
		if (steering.length === 0 && followUp.length === 0) {
			this.ui.requestRender();
			return;
		}
		this.pendingMessagesContainer.addChild(new Spacer(1));
		for (const message of steering) {
			this.pendingMessagesContainer.addChild(new Text(theme.fg("dim", `Steering: ${message}`), 1, 0));
		}
		for (const message of followUp) {
			this.pendingMessagesContainer.addChild(new Text(theme.fg("dim", `Follow-up: ${message}`), 1, 0));
		}
		this.pendingMessagesContainer.addChild(
			new Text(theme.fg("dim", `${keyText("app.message.dequeue")} to edit queued messages`), 1, 0),
		);
		this.ui.requestRender();
	}

	private async handleEvent(event: unknown): Promise<void> {
		const type = getRecordType(event);
		if (type === "extension_ui_request" && this.isExtensionUiRequest(event)) {
			await this.handleExtensionUiRequest(event);
			return;
		}
		if (type === "daemon_error" && isRecord(event) && typeof event.error === "string") {
			this.showError(event.error);
			return;
		}
		if (type === "prompt_complete") {
			await this.refreshState().catch(() => undefined);
			return;
		}
		if (!type) {
			return;
		}
		const sessionEvent = event as AgentSessionEvent;
		switch (sessionEvent.type) {
			case "agent_start":
				this.pendingTools.clear();
				this.state = this.state ? { ...this.state, isStreaming: true } : this.state;
				this.footer.setState(this.state);
				this.stopWorkingLoader();
				this.loadingAnimation = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					`Working... (${keyText("app.interrupt")} to interrupt)`,
				);
				this.statusContainer.addChild(this.loadingAnimation);
				this.ui.requestRender();
				break;

			case "queue_update":
				this.steeringMessages = [...sessionEvent.steering];
				this.followUpMessages = [...sessionEvent.followUp];
				this.updatePendingMessagesDisplay();
				break;

			case "session_info_changed":
				if (this.state) {
					this.state = { ...this.state, sessionName: sessionEvent.name };
					this.footer.setState(this.state);
				}
				this.updateTerminalTitle();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				if (this.state) {
					this.state = { ...this.state, thinkingLevel: sessionEvent.level };
					this.footer.setState(this.state);
				}
				this.updateEditorBorderColor();
				this.ui.requestRender();
				break;

			case "task_notification":
			case "monitor_event":
			case "subagent_notification":
			case "proactive_trigger_event":
				this.addMessageToChat({
					role: "custom",
					customType: sessionEvent.type,
					content: sessionEvent.xml,
					display: true,
					details: sessionEvent.notification,
					timestamp: Date.now(),
				});
				this.ui.requestRender();
				break;

			case "message_start":
				if (sessionEvent.message.role === "custom" || sessionEvent.message.role === "user") {
					this.addMessageToChat(sessionEvent.message);
				} else if (sessionEvent.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
					);
					this.streamingMessage = sessionEvent.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
				}
				this.ui.requestRender();
				break;

			case "message_update":
				if (this.streamingComponent && sessionEvent.message.role === "assistant") {
					this.streamingMessage = sessionEvent.message;
					this.streamingComponent.updateContent(this.streamingMessage);
					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							const existing = this.pendingTools.get(content.id);
							if (existing) {
								existing.updateArgs(content.arguments);
							} else {
								const component = this.createToolComponent(content.name, content.id, content.arguments);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							}
						}
					}
				}
				this.ui.requestRender();
				break;

			case "message_end":
				if (sessionEvent.message.role === "assistant" && this.streamingComponent) {
					this.streamingMessage = sessionEvent.message;
					this.streamingComponent.updateContent(this.streamingMessage);
					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						const text = this.streamingMessage.errorMessage ?? "Error";
						for (const component of this.pendingTools.values()) {
							component.updateResult({ content: [{ type: "text", text }], isError: true });
						}
						this.pendingTools.clear();
					} else {
						for (const component of this.pendingTools.values()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				const component =
					this.pendingTools.get(sessionEvent.toolCallId) ??
					this.createToolComponent(sessionEvent.toolName, sessionEvent.toolCallId, sessionEvent.args);
				if (!this.pendingTools.has(sessionEvent.toolCallId)) {
					this.chatContainer.addChild(component);
					this.pendingTools.set(sessionEvent.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(sessionEvent.toolCallId);
				const result = toToolResultPayload(sessionEvent.partialResult, false);
				if (component && result) {
					component.updateResult(result, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(sessionEvent.toolCallId);
				const result = toToolResultPayload(sessionEvent.result, sessionEvent.isError);
				if (component && result) {
					component.updateResult(result);
					this.pendingTools.delete(sessionEvent.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				this.state = this.state ? { ...this.state, isStreaming: false } : this.state;
				this.footer.setState(this.state);
				this.stopWorkingLoader();
				this.pendingTools.clear();
				await this.refreshState().catch(() => undefined);
				break;

			case "compaction_start":
				this.state = this.state ? { ...this.state, isCompacting: true } : this.state;
				this.footer.setState(this.state);
				this.statusContainer.clear();
				this.compactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					`Compacting context... (${keyText("app.interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.compactionLoader);
				this.ui.requestRender();
				break;

			case "compaction_end":
				this.state = this.state ? { ...this.state, isCompacting: false } : this.state;
				this.footer.setState(this.state);
				if (this.compactionLoader) {
					this.compactionLoader.stop();
					this.compactionLoader = undefined;
				}
				this.statusContainer.clear();
				if (sessionEvent.aborted) {
					this.showStatus("Compaction cancelled");
				} else if (sessionEvent.result) {
					this.chatContainer.clear();
					await this.renderCurrentMessages().catch(() => undefined);
					this.addMessageToChat(
						createCompactionSummaryMessage(
							sessionEvent.result.summary,
							sessionEvent.result.tokensBefore,
							new Date().toISOString(),
						),
					);
				} else if (sessionEvent.errorMessage) {
					this.showError(sessionEvent.errorMessage);
				}
				await this.refreshState().catch(() => undefined);
				await this.flushCompactionQueue();
				this.ui.requestRender();
				break;

			case "auto_retry_start":
				this.statusContainer.clear();
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					`Retrying (${sessionEvent.attempt}/${sessionEvent.maxAttempts})... (${keyText("app.interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;

			case "auto_retry_end":
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				this.statusContainer.clear();
				if (!sessionEvent.success) {
					this.showError(
						`Retry failed after ${sessionEvent.attempt} attempts: ${sessionEvent.finalError ?? "Unknown error"}`,
					);
				}
				this.ui.requestRender();
				break;

			case "session_reloaded":
				await this.refreshCommands();
				await this.refreshState();
				this.showStatus("Daemon session reloaded");
				break;
		}
	}

	private isExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
		return isRecord(value) && value.type === "extension_ui_request" && typeof value.id === "string";
	}

	private async handleExtensionUiRequest(request: RpcExtensionUIRequest): Promise<void> {
		switch (request.method) {
			case "select":
				await this.showExtensionSelector(request.id, request.title, request.options, (value) => ({
					type: "extension_ui_response",
					id: request.id,
					value,
				}));
				break;
			case "confirm":
				await this.showExtensionSelector(
					request.id,
					`${request.title}\n${request.message}`,
					["Yes", "No"],
					(value) => ({
						type: "extension_ui_response",
						id: request.id,
						confirmed: value === "Yes",
					}),
				);
				break;
			case "input":
				await this.showExtensionInput(request.title, request.placeholder, request.id);
				break;
			case "editor":
				await this.showExtensionEditor(request.title, request.prefill, request.id);
				break;
			case "notify":
				this.showExtensionNotify(request.message, request.notifyType);
				break;
			case "setStatus":
				this.footerDataProvider.setExtensionStatus(request.statusKey, request.statusText);
				this.ui.requestRender();
				break;
			case "setWidget":
				this.setExtensionWidget(request.widgetKey, request.widgetLines);
				break;
			case "setTitle":
				this.ui.terminal.setTitle(request.title);
				break;
			case "set_editor_text":
				this.editor.setText(request.text);
				this.ui.requestRender();
				break;
		}
	}

	private showExtensionSelector(
		id: string,
		title: string,
		options: string[],
		createResponse: (value: string) => RpcExtensionUIResponse,
	): Promise<void> {
		return new Promise((resolve) => {
			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(value) => {
					this.hideExtensionSelector();
					this.client.sendExtensionUiResponse(createResponse(value));
					resolve();
				},
				() => {
					this.hideExtensionSelector();
					this.client.sendExtensionUiResponse({ type: "extension_ui_response", id, cancelled: true });
					resolve();
				},
				{ tui: this.ui, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.extensionSelector = undefined;
		this.restoreEditorFocus();
	}

	private showExtensionInput(title: string, placeholder: string | undefined, id: string): Promise<void> {
		return new Promise((resolve) => {
			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					this.hideExtensionInput();
					this.client.sendExtensionUiResponse({ type: "extension_ui_response", id, value });
					resolve();
				},
				() => {
					this.hideExtensionInput();
					this.client.sendExtensionUiResponse({ type: "extension_ui_response", id, cancelled: true });
					resolve();
				},
				{ tui: this.ui },
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	private hideExtensionInput(): void {
		this.extensionInput = undefined;
		this.restoreEditorFocus();
	}

	private showExtensionEditor(title: string, prefill: string | undefined, id: string): Promise<void> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					this.client.sendExtensionUiResponse({ type: "extension_ui_response", id, value });
					resolve();
				},
				() => {
					this.hideExtensionEditor();
					this.client.sendExtensionUiResponse({ type: "extension_ui_response", id, cancelled: true });
					resolve();
				},
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	private hideExtensionEditor(): void {
		this.extensionEditor = undefined;
		this.restoreEditorFocus();
	}

	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	private setExtensionWidget(key: string, lines: string[] | undefined): void {
		const existing = this.extensionWidgets.get(key);
		existing?.dispose?.();
		this.extensionWidgets.delete(key);
		if (lines) {
			const container = new Container();
			for (const line of lines.slice(0, 10)) {
				container.addChild(new Text(line, 1, 0));
			}
			this.extensionWidgets.set(key, container);
		}
		this.widgetContainer.clear();
		if (this.extensionWidgets.size > 0) {
			this.widgetContainer.addChild(new Spacer(1));
			for (const widget of this.extensionWidgets.values()) {
				this.widgetContainer.addChild(widget);
			}
		}
		this.ui.requestRender();
	}

	private restoreEditorFocus(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private async handleResetCommand(): Promise<void> {
		try {
			const result = await this.client.newSession();
			if (result.cancelled) {
				this.showStatus("Reset cancelled");
				return;
			}
			await this.refreshState();
			await this.refreshCommands();
			await this.renderCurrentMessages();
			this.showStatus("Daemon conversation reset");
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		try {
			await this.client.compact(customInstructions);
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async handleReloadCommand(): Promise<void> {
		try {
			await this.client.reload();
			await this.refreshCommands();
			await this.refreshState();
			this.showStatus("Reloaded daemon keybindings, extensions, skills, prompts, and themes");
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async handleSessionCommand(): Promise<void> {
		await this.refreshState();
		const stats = this.stats;
		const state = this.state;
		if (!stats || !state) {
			this.showWarning("Conversation information is unavailable");
			return;
		}
		const info = [
			theme.bold("Conversation Info"),
			"",
			`${theme.fg("dim", "Name:")} ${state.sessionName ?? "(unnamed)"}`,
			`${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}`,
			`${theme.fg("dim", "ID:")} ${stats.sessionId}`,
			"",
			theme.bold("Messages"),
			`${theme.fg("dim", "User:")} ${stats.userMessages}`,
			`${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}`,
			`${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}`,
			`${theme.fg("dim", "Tool Results:")} ${stats.toolResults}`,
			`${theme.fg("dim", "Total:")} ${stats.totalMessages}`,
			"",
			theme.bold("Tokens"),
			`${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}`,
			`${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}`,
			`${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}`,
		].join("\n");
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private async handleNameCommand(text: string): Promise<void> {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			this.showStatus(`Conversation name: ${this.state?.sessionName ?? "(unnamed)"}`);
			return;
		}
		try {
			await this.client.setSessionName(name);
			await this.refreshState();
			this.showStatus(`Conversation name set: ${name}`);
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = getPathCommandArgument(text, "/export");
		try {
			const result = await this.client.exportHtml(outputPath);
			this.showStatus(`Conversation exported to: ${result.path}`);
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async handleCopyCommand(): Promise<void> {
		try {
			const text = await this.client.getLastAssistantText();
			if (!text) {
				this.showWarning("No assistant message to copy yet.");
				return;
			}
			await copyToClipboard(text);
			this.showStatus("Copied last assistant message to clipboard");
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async handleModelCommand(query?: string): Promise<void> {
		if (this.availableModels.length === 0) {
			await this.refreshState();
		}
		const directModel = query ? parseDaemonModelQuery(query) : undefined;
		if (directModel) {
			await this.setModel(directModel.provider, directModel.modelId);
			return;
		}
		this.showModelSelector(query);
	}

	private showModelSelector(initialQuery?: string): void {
		if (this.availableModels.length === 0) {
			this.showWarning("No available models");
			return;
		}
		const currentModel = this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : undefined;
		const selector = new DaemonModelSelectorComponent(
			this.ui,
			this.availableModels,
			currentModel,
			(model) => {
				this.restoreEditorFocus();
				void this.setModel(model.provider, model.id);
			},
			() => this.restoreEditorFocus(),
			initialQuery,
		);
		this.editorContainer.clear();
		this.editorContainer.addChild(selector);
		this.ui.setFocus(selector);
		this.ui.requestRender();
	}

	private async setModel(provider: string, modelId: string): Promise<void> {
		try {
			const model = await this.client.setModel(provider, modelId);
			await this.refreshState();
			this.showStatus(`Switched to ${model.provider}/${model.id}`);
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.client.cycleModel(direction);
			if (!result) {
				this.showStatus("Only one model available");
				return;
			}
			await this.refreshState();
			const thinkingText =
				result.model && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
			this.showStatus(`Switched to ${result.model.provider}/${result.model.id}${thinkingText}`);
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async cycleThinkingLevel(): Promise<void> {
		try {
			const result = await this.client.cycleThinkingLevel();
			if (!result) {
				this.showStatus("Current model does not support thinking");
				return;
			}
			await this.refreshState();
			this.showStatus(`Thinking level: ${result.level}`);
		} catch (error: unknown) {
			this.showError(error);
		}
	}

	private async handleBashCommand(command: string, excludeFromContext: boolean): Promise<void> {
		if (this.bashComponent) {
			this.showWarning("A bash command is already running. Press Esc to cancel it first.");
			return;
		}
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
		this.chatContainer.addChild(this.bashComponent);
		this.ui.requestRender();
		try {
			const result = await this.client.bash(command, { excludeFromContext });
			this.completeBash(result);
			await this.refreshState().catch(() => undefined);
		} catch (error: unknown) {
			this.bashComponent.setComplete(undefined, false);
			this.showError(error);
		} finally {
			this.bashComponent = undefined;
			this.ui.requestRender();
		}
	}

	private completeBash(result: BashResult): void {
		if (!this.bashComponent) {
			return;
		}
		if (result.output) {
			this.bashComponent.appendOutput(result.output);
		}
		this.bashComponent.setComplete(
			result.exitCode,
			result.cancelled,
			result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
			result.fullOutputPath,
		);
	}

	private handleHotkeysCommand(): void {
		const text = [
			"**Daemon Attach Shortcuts**",
			"",
			`| \`${keyText("tui.input.submit")}\` | Send message |`,
			`| \`${keyText("app.interrupt")}\` | Abort current response |`,
			`| \`${keyText("app.clear")}\` | Clear editor / exit on second press |`,
			`| \`${keyText("app.exit")}\` | Exit when editor is empty |`,
			`| \`${keyText("app.message.followUp")}\` | Queue follow-up |`,
			`| \`${keyText("app.model.cycleForward")}\` / \`${keyText("app.model.cycleBackward")}\` | Cycle models |`,
			`| \`${keyText("app.thinking.cycle")}\` | Cycle thinking level |`,
			`| \`${keyText("app.tools.expand")}\` | Toggle expanded output |`,
			"",
			"`/model`, `/reset`, `/compact`, `/session`, `/name`, `/export`, `/copy`, `/quit`",
		].join("\n");
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Markdown(text, 1, 0, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private toggleToolOutputExpansion(): void {
		this.toolOutputExpanded = !this.toolOutputExpanded;
		for (const child of this.chatContainer.children) {
			if (isRecord(child) && "setExpanded" in child && typeof child.setExpanded === "function") {
				child.setExpanded(this.toolOutputExpanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async openExternalEditor(): Promise<void> {
		const editorCommand = process.env.VISUAL || process.env.EDITOR;
		if (!editorCommand) {
			this.showWarning("No editor configured. Set VISUAL or EDITOR.");
			return;
		}
		const tmpFile = path.join(os.tmpdir(), `morgan-daemon-editor-${Date.now()}.md`);
		fs.writeFileSync(tmpFile, this.editor.getText(), "utf8");
		this.ui.stop();
		process.stdout.write(`Launching external editor: ${editorCommand}\nPi will resume when the editor exits.\n`);
		const [command, ...args] = editorCommand.split(" ");
		const status = await new Promise<number | null>((resolve) => {
			const proc = spawn(command, [...args, tmpFile], { stdio: "inherit", shell: process.platform === "win32" });
			proc.on("error", () => resolve(null));
			proc.on("close", (code) => resolve(code));
		});
		if (status === 0) {
			this.editor.setText(fs.readFileSync(tmpFile, "utf8").replace(/\n$/, ""));
		}
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors for the temporary editor file.
		}
		this.ui.start();
		this.ui.requestRender(true);
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.state?.thinkingLevel ?? "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private stopWorkingLoader(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
	}

	private showStatus(message: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.ui.requestRender();
	}

	private showWarning(message: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${message}`), 1, 0));
		this.ui.requestRender();
	}

	private showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${message}`), 1, 0));
		this.ui.requestRender();
	}

	private handleCtrlC(): void {
		if (this.editor.getText()) {
			this.editor.setText("");
			this.ui.requestRender();
			return;
		}
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.lastSigintTime = now;
			this.showStatus(`Press ${keyText("app.clear")} again to exit`);
		}
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});
		this.ui.stop();
		process.kill(0, "SIGTSTP");
	}

	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.cwd);
		const sessionName = this.state?.sessionName;
		this.ui.terminal.setTitle(
			sessionName ? `${APP_TITLE} daemon - ${sessionName} - ${cwdBasename}` : `${APP_TITLE} daemon - ${cwdBasename}`,
		);
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void this.shutdown({ exitCode: signal === "SIGHUP" ? 129 : 143 });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				process.exit(129);
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private async shutdown(options?: { exitCode?: number }): Promise<never> {
		if (this.shuttingDown) {
			process.exit(options?.exitCode ?? 0);
		}
		this.shuttingDown = true;
		this.unregisterSignalHandlers();
		this.unsubscribeEvents?.();
		for (const widget of this.extensionWidgets.values()) {
			widget.dispose?.();
		}
		this.footerDataProvider.dispose();
		stopThemeWatcher();
		await this.ui.terminal.drainInput(1000);
		if (this.initialized) {
			this.ui.stop();
		}
		this.client.close();
		process.exit(options?.exitCode ?? 0);
	}
}

export async function runDaemonInteractiveMode(): Promise<void> {
	const client = new DaemonClient({ requestTimeoutMs: 300000 });
	const mode = new DaemonInteractiveMode(client);
	await mode.run();
}
