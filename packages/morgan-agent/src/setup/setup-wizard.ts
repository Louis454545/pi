import type { ThinkingLevel } from "@earendil-works/morgan-agent-core";
import type { Api, Model } from "@earendil-works/morgan-ai";
import type { AuthStorage } from "../core/auth-storage.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import { defaultModelPerProvider } from "../core/model-resolver.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	type AutostartRunner,
	disableDaemonAutostart,
	enableDaemonAutostart,
	getDaemonAutostartProvider,
} from "../daemon/autostart.ts";
import type { AuthSelectorProvider } from "../modes/interactive/components/oauth-selector.ts";
import {
	type BrowserHarnessRunner,
	type BrowserHarnessSetupResult,
	setupBrowserHarness,
} from "./browser-harness-setup.ts";
import type { SelectOption, SetupPrompter } from "./prompter.ts";
import {
	type BrowserSetupChoice,
	type CommunicationSetupChoice,
	type DaemonAutostartSetupChoice,
	type SetupResumeChoice,
	SetupStateStore,
	type SetupStep,
} from "./setup-state.ts";
import {
	setupTelegramBridge,
	type TelegramBridgeClient,
	type TelegramBridgeSetupResult,
} from "./telegram-bridge-setup.ts";

type AuthChoice = "api-key" | "subscription" | "skip";
type SetupStartChoice = "custom" | "skip";

export interface SetupWizardOptions {
	force?: boolean;
	nonInteractive?: boolean;
	authChoice?: AuthChoice;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	apiKey?: string;
	communicationChoice?: CommunicationSetupChoice;
	browserChoice?: BrowserSetupChoice;
	daemonAutostartChoice?: DaemonAutostartSetupChoice;
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	prompter: SetupPrompter;
	browserRunner?: BrowserHarnessRunner;
	telegramClient?: TelegramBridgeClient;
	daemonAutostartRunner?: AutostartRunner;
	setupStateStore?: SetupStateStore;
}

export interface DaemonSetupResult {
	status: "ready" | "skipped" | "unsupported" | "error";
	messages: string[];
}

export interface SetupWizardResult {
	launchMorgan: boolean;
	browser: BrowserHarnessSetupResult;
	communication: TelegramBridgeSetupResult;
	daemon: DaemonSetupResult;
}

function uniqueProviders(models: Model<Api>[]): string[] {
	return Array.from(new Set(models.map((model) => model.provider))).sort();
}

function defaultModelForProvider(provider: string, models: Model<Api>[]): Model<Api> | undefined {
	const providerModels = models.filter((model) => model.provider === provider);
	const defaultModelId = defaultModelPerProvider[provider as keyof typeof defaultModelPerProvider];
	return providerModels.find((model) => model.id === defaultModelId) ?? providerModels[0];
}

async function selectProvider(
	modelRegistry: ModelRegistry,
	prompter: SetupPrompter,
	providers: string[],
	message: string,
	authType: AuthSelectorProvider["authType"],
): Promise<string | undefined> {
	if (providers.length === 0) {
		prompter.warn("No providers are available.");
		return undefined;
	}

	const providerOptions: AuthSelectorProvider[] = providers.map((provider) => ({
		id: provider,
		name: modelRegistry.getProviderDisplayName(provider),
		authType,
	}));
	if (prompter.selectAuthProvider) {
		return await prompter.selectAuthProvider(message, providerOptions);
	}

	const options: SelectOption<string>[] = providerOptions.map((provider) => ({
		id: provider.id,
		label: provider.name,
		description: provider.id,
	}));
	return await prompter.select(message, options);
}

async function configureModelDefaults(
	provider: string,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
	prompter: SetupPrompter,
	selectedModelId?: string,
	selectedThinkingLevel?: ThinkingLevel,
): Promise<void> {
	const models = modelRegistry.getAll().filter((model) => model.provider === provider);
	if (models.length === 0) {
		prompter.warn(`No models found for provider "${provider}".`);
		settingsManager.setDefaultProvider(provider);
		await settingsManager.flush();
		return;
	}

	const defaultModel = defaultModelForProvider(provider, modelRegistry.getAll());
	if (selectedModelId) {
		if (!models.some((model) => model.id === selectedModelId)) {
			throw new Error(`Model "${provider}/${selectedModelId}" is not available.`);
		}
		settingsManager.setDefaultModelAndProvider(provider, selectedModelId);
	} else if (!prompter.selectModel) {
		const options: SelectOption<string>[] = models
			.slice()
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((model) => ({
				id: model.id,
				label: model.name ? `${model.name} (${model.id})` : model.id,
			}));
		const selectedModelId = await prompter.select("Choose the default model:", options, {
			defaultId: defaultModel?.id,
		});
		settingsManager.setDefaultModelAndProvider(provider, selectedModelId);
	} else {
		const selectedModel = await prompter.selectModel({
			provider,
			models,
			currentModel: defaultModel,
		});
		if (!selectedModel) {
			return;
		}
		settingsManager.setDefaultModelAndProvider(selectedModel.provider, selectedModel.id);
	}
	const thinkingLevel =
		selectedThinkingLevel ??
		(await prompter.select<ThinkingLevel>(
			"Choose the default thinking level:",
			[
				{ id: "medium", label: "medium" },
				{ id: "low", label: "low" },
				{ id: "high", label: "high" },
				{ id: "off", label: "off" },
				{ id: "minimal", label: "minimal" },
				{ id: "xhigh", label: "xhigh" },
			],
			{ defaultId: "medium" },
		));
	settingsManager.setDefaultThinkingLevel(thinkingLevel);
	settingsManager.setEnableSkillCommands(true);
	await settingsManager.flush();
}

async function configureApiKeyAuth(options: SetupWizardOptions): Promise<void> {
	const providers = uniqueProviders(options.modelRegistry.getAll());
	const provider =
		options.provider ??
		(await selectProvider(
			options.modelRegistry,
			options.prompter,
			providers,
			"Choose an API key provider:",
			"api_key",
		));
	if (!provider) {
		return;
	}
	if (!providers.includes(provider)) {
		throw new Error(`Provider "${provider}" is not available.`);
	}

	const providerName = options.modelRegistry.getProviderDisplayName(provider);
	if (!options.force && options.authStorage.has(provider)) {
		const replace = await options.prompter.confirm(
			`A stored credential already exists for ${providerName}. Replace it?`,
			false,
		);
		if (!replace) {
			await configureModelDefaults(
				provider,
				options.modelRegistry,
				options.settingsManager,
				options.prompter,
				options.model,
				options.thinkingLevel,
			);
			return;
		}
	}

	const apiKey = options.apiKey ?? (await options.prompter.input(`Paste API key for ${providerName}:`));
	options.authStorage.set(provider, { type: "api_key", key: apiKey });
	options.modelRegistry.refresh();
	await configureModelDefaults(
		provider,
		options.modelRegistry,
		options.settingsManager,
		options.prompter,
		options.model,
		options.thinkingLevel,
	);
	options.prompter.info(`Saved API key for ${providerName}.`);
}

async function configureSubscriptionAuth(options: SetupWizardOptions): Promise<void> {
	const oauthProviders = options.authStorage.getOAuthProviders();
	if (oauthProviders.length === 0) {
		options.prompter.warn("No subscription providers are available.");
		return;
	}

	const provider = await selectProvider(
		options.modelRegistry,
		options.prompter,
		oauthProviders
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((provider) => provider.id),
		"Choose a subscription provider:",
		"oauth",
	);
	if (!provider) {
		return;
	}

	const providerInfo = oauthProviders.find((oauthProvider) => oauthProvider.id === provider);
	const providerName = providerInfo?.name ?? options.modelRegistry.getProviderDisplayName(provider);
	if (!options.force && options.authStorage.has(provider)) {
		const replace = await options.prompter.confirm(
			`A stored subscription credential already exists for ${providerName}. Replace it?`,
			false,
		);
		if (!replace) {
			await configureModelDefaults(
				provider,
				options.modelRegistry,
				options.settingsManager,
				options.prompter,
				options.model,
				options.thinkingLevel,
			);
			return;
		}
	}

	await options.prompter.loginOAuth(
		provider,
		providerName,
		providerInfo?.usesCallbackServer ?? false,
		async (callbacks) => {
			await options.authStorage.login(provider, callbacks);
		},
	);
	options.modelRegistry.refresh();
	await configureModelDefaults(
		provider,
		options.modelRegistry,
		options.settingsManager,
		options.prompter,
		options.model,
		options.thinkingLevel,
	);
	options.prompter.info(`Logged in to ${providerName}.`);
}

async function configureAuthAndModel(options: SetupWizardOptions): Promise<void> {
	const hasDefaults = !!options.settingsManager.getDefaultProvider() && !!options.settingsManager.getDefaultModel();
	if (hasDefaults && !options.force) {
		options.prompter.info("Existing default model configuration found. Use `morgan setup --force` to change it.");
		return;
	}

	const authChoice =
		options.authChoice ??
		(options.provider || options.apiKey
			? "api-key"
			: await options.prompter.select<AuthChoice>(
					"Choose authentication setup:",
					[
						{ id: "api-key", label: "API key" },
						{ id: "subscription", label: "Subscription login" },
						{ id: "skip", label: "Skip for now" },
					],
					{ defaultId: "api-key" },
				));

	if (authChoice === "api-key") {
		await configureApiKeyAuth(options);
	} else if (authChoice === "subscription") {
		await configureSubscriptionAuth(options);
	} else {
		if (options.provider && options.model) {
			await configureModelDefaults(
				options.provider,
				options.modelRegistry,
				options.settingsManager,
				options.prompter,
				options.model,
				options.thinkingLevel,
			);
		}
		options.prompter.info("Skipped authentication. Morgan will ask for a model/login when needed.");
	}
}

async function configureCommunicationBridge(options: SetupWizardOptions): Promise<TelegramBridgeSetupResult> {
	const communicationChoice =
		options.communicationChoice ??
		(await options.prompter.select<CommunicationSetupChoice>(
			"Choose communication channel:",
			[
				{ id: "tui", label: "TUI only" },
				{ id: "telegram", label: "Telegram" },
			],
			{ defaultId: "tui" },
		));

	if (communicationChoice === "tui") {
		return { status: "skipped", messages: ["Communication channel: TUI only."] };
	}

	return await setupTelegramBridge({
		agentDir: options.agentDir,
		force: options.force,
		prompter: options.prompter,
		client: options.telegramClient,
	});
}

async function configureBrowserHarness(options: SetupWizardOptions): Promise<BrowserHarnessSetupResult> {
	const browserChoice =
		options.browserChoice ??
		(await options.prompter.select<BrowserSetupChoice>(
			"Configure browser control?",
			[
				{ id: "install", label: "Install browser harness" },
				{ id: "later", label: "Install later" },
				{ id: "skip", label: "Skip browser control" },
			],
			{ defaultId: "install" },
		));

	if (browserChoice === "skip") {
		return { status: "skipped", messages: ["Browser control: skipped. Run `morgan setup --force` to configure it."] };
	}
	if (browserChoice === "later") {
		return { status: "pending", messages: ["Browser control: install later. Run `morgan setup --force`."] };
	}

	return await setupBrowserHarness({
		agentDir: options.agentDir,
		force: options.force,
		prompter: options.prompter,
		runner: options.browserRunner,
	});
}

async function configureDaemon(options: SetupWizardOptions): Promise<DaemonSetupResult> {
	options.settingsManager.setDaemonEnabled(true);
	const provider = getDaemonAutostartProvider(options.daemonAutostartRunner?.platform);

	if (!provider) {
		options.settingsManager.setDaemonStartAtLogin(false);
		options.settingsManager.setDaemonAutostartProvider(undefined);
		await options.settingsManager.flush();
		if (options.daemonAutostartChoice === "enable") {
			return {
				status: "unsupported",
				messages: ["Daemon: enabled for normal launches. Login autostart is supported on Linux and macOS only."],
			};
		}
		return {
			status: "skipped",
			messages: ["Daemon: enabled for normal launches. Login autostart is not available on this platform."],
		};
	}

	if (options.nonInteractive && !options.daemonAutostartChoice) {
		await options.settingsManager.flush();
		return { status: "skipped", messages: ["Daemon: enabled for normal launches. Login autostart unchanged."] };
	}

	const choice =
		options.daemonAutostartChoice ??
		(await options.prompter.select<DaemonAutostartSetupChoice>(
			"Start Morgan automatically at login?",
			[
				{ id: "enable", label: "Start at login" },
				{ id: "disable", label: "Do not start at login" },
				{ id: "skip", label: "Configure later" },
			],
			{ defaultId: "enable" },
		));

	if (choice === "enable") {
		try {
			const status = await enableDaemonAutostart({ runner: options.daemonAutostartRunner });
			if (!status.supported) {
				options.settingsManager.setDaemonStartAtLogin(false);
				options.settingsManager.setDaemonAutostartProvider(undefined);
				await options.settingsManager.flush();
				return { status: "unsupported", messages: [`Daemon: ${status.message}`] };
			}
			options.settingsManager.setDaemonStartAtLogin(true);
			options.settingsManager.setDaemonAutostartProvider(status.provider);
			await options.settingsManager.flush();
			return {
				status: "ready",
				messages: [`Daemon: enabled for normal launches and login startup (${status.provider}).`],
			};
		} catch (error: unknown) {
			options.settingsManager.setDaemonStartAtLogin(false);
			options.settingsManager.setDaemonAutostartProvider(undefined);
			await options.settingsManager.flush();
			const message = error instanceof Error ? error.message : String(error);
			return { status: "error", messages: [`Daemon: login startup could not be enabled: ${message}`] };
		}
	}

	if (choice === "disable") {
		try {
			await disableDaemonAutostart({ runner: options.daemonAutostartRunner });
		} catch {
			// Keep setup non-blocking when disabling an absent or broken login item.
		}
		options.settingsManager.setDaemonStartAtLogin(false);
		options.settingsManager.setDaemonAutostartProvider(provider);
		await options.settingsManager.flush();
		return { status: "skipped", messages: ["Daemon: enabled for normal launches. Login startup disabled."] };
	}

	await options.settingsManager.flush();
	return { status: "skipped", messages: ["Daemon: enabled for normal launches. Login startup not changed."] };
}

function reportSummary(
	options: SetupWizardOptions,
	browser: BrowserHarnessSetupResult,
	communication: TelegramBridgeSetupResult,
	daemon: DaemonSetupResult,
): void {
	options.prompter.info("Setup summary:");
	options.prompter.info(`Model: ${options.settingsManager.getDefaultProvider() ?? "not configured"}`);
	options.prompter.info(`Communication: ${communication.status}`);
	options.prompter.info(`Daemon: ${daemon.status}`);
	options.prompter.info(`Browser: ${browser.status}`);
}

async function resolveSetupStart(options: SetupWizardOptions, stateStore: SetupStateStore): Promise<SetupStartChoice> {
	if (options.force || options.nonInteractive) {
		stateStore.clear();
		return "custom";
	}

	const savedState = !options.force && !options.nonInteractive ? stateStore.load() : undefined;
	if (savedState && savedState.completedSteps.length > 0) {
		const resumeChoice = await options.prompter.select<SetupResumeChoice>(
			"Resume previous setup?",
			[
				{ id: "resume", label: "Resume setup" },
				{ id: "start-over", label: "Start over" },
				{ id: "skip", label: "Skip setup" },
			],
			{ defaultId: "resume" },
		);
		if (resumeChoice === "skip") {
			return "skip";
		}
		if (resumeChoice === "start-over") {
			stateStore.clear();
		} else {
			return "custom";
		}
	}

	return await options.prompter.select<SetupStartChoice>(
		"Run Morgan setup?",
		[
			{ id: "custom", label: "Start setup" },
			{ id: "skip", label: "Skip for now" },
		],
		{ defaultId: "custom" },
	);
}

function isStepCompleted(stateStore: SetupStateStore, step: SetupStep): boolean {
	return stateStore.load()?.completedSteps.includes(step) ?? false;
}

async function runSetupStep(
	options: SetupWizardOptions,
	stateStore: SetupStateStore,
	step: SetupStep,
	fn: () => Promise<void>,
): Promise<void> {
	if (!options.force && isStepCompleted(stateStore, step)) {
		return;
	}
	await fn();
	stateStore.markCompleted(step);
}

export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupWizardResult> {
	const stateStore = options.setupStateStore ?? new SetupStateStore(options.agentDir);
	const setupStart = await resolveSetupStart(options, stateStore);
	if (setupStart === "skip") {
		options.prompter.info("Skipped setup. Run `morgan setup` when you are ready.");
		return {
			launchMorgan: false,
			browser: { status: "skipped", messages: ["Browser control: skipped."] },
			communication: { status: "skipped", messages: ["Communication channel: skipped."] },
			daemon: { status: "skipped", messages: ["Daemon: skipped."] },
		};
	}

	stateStore.update((state) => ({ ...state, profile: "custom" }));

	await runSetupStep(options, stateStore, "authModel", async () => {
		await configureAuthAndModel(options);
	});

	let communication: TelegramBridgeSetupResult = { status: "skipped", messages: ["Communication channel: TUI only."] };
	await runSetupStep(options, stateStore, "communication", async () => {
		communication = await configureCommunicationBridge(options);
		stateStore.update((state) => ({ ...state, communicationChoice: options.communicationChoice ?? "tui" }));
	});
	for (const message of communication.messages) {
		if (communication.status === "ready" || communication.status === "skipped") {
			options.prompter.info(message);
		} else {
			options.prompter.warn(message);
		}
	}

	await runSetupStep(options, stateStore, "skills", async () => {
		options.settingsManager.setEnableSkillCommands(true);
		await options.settingsManager.flush();
	});

	let daemon: DaemonSetupResult = { status: "skipped", messages: ["Daemon: enabled for normal launches."] };
	await runSetupStep(options, stateStore, "daemon", async () => {
		daemon = await configureDaemon(options);
		if (options.daemonAutostartChoice) {
			stateStore.update((state) => ({ ...state, daemonAutostartChoice: options.daemonAutostartChoice }));
		}
	});
	for (const message of daemon.messages) {
		if (daemon.status === "ready" || daemon.status === "skipped") {
			options.prompter.info(message);
		} else {
			options.prompter.warn(message);
		}
	}

	let browser: BrowserHarnessSetupResult = { status: "skipped", messages: ["Browser control: skipped."] };
	await runSetupStep(options, stateStore, "browser", async () => {
		browser = await configureBrowserHarness(options);
		if (options.browserChoice) {
			stateStore.update((state) => ({ ...state, browserChoice: options.browserChoice }));
		}
	});

	for (const message of browser.messages) {
		if (browser.status === "ready" || browser.status === "skipped") {
			options.prompter.info(message);
		} else {
			options.prompter.warn(message);
		}
	}

	reportSummary(options, browser, communication, daemon);
	options.prompter.info("Setup complete.");
	stateStore.clear();
	return { launchMorgan: true, browser, communication, daemon };
}
