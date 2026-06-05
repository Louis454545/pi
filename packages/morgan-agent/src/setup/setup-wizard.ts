import type { ThinkingLevel } from "@earendil-works/morgan-agent-core";
import type { Api, Model } from "@earendil-works/morgan-ai";
import type { AuthStorage } from "../core/auth-storage.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import { defaultModelPerProvider } from "../core/model-resolver.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import type { AuthSelectorProvider } from "../modes/interactive/components/oauth-selector.ts";
import {
	type BrowserHarnessRunner,
	type BrowserHarnessSetupResult,
	setupBrowserHarness,
} from "./browser-harness-setup.ts";
import type { SelectOption, SetupPrompter } from "./prompter.ts";

type AuthChoice = "api-key" | "subscription" | "skip";

export interface SetupWizardOptions {
	force?: boolean;
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	prompter: SetupPrompter;
	browserRunner?: BrowserHarnessRunner;
}

export interface SetupWizardResult {
	launchMorgan: boolean;
	browser: BrowserHarnessSetupResult;
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
): Promise<void> {
	const models = modelRegistry.getAll().filter((model) => model.provider === provider);
	if (models.length === 0) {
		prompter.warn(`No models found for provider "${provider}".`);
		settingsManager.setDefaultProvider(provider);
		await settingsManager.flush();
		return;
	}

	const defaultModel = defaultModelForProvider(provider, modelRegistry.getAll());
	const selectedModel = await prompter.selectModel?.({
		provider,
		models,
		currentModel: defaultModel,
	});
	if (selectedModel) {
		settingsManager.setDefaultModelAndProvider(selectedModel.provider, selectedModel.id);
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
		return;
	}
	const thinkingLevel = await prompter.select<ThinkingLevel>(
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
	);
	settingsManager.setDefaultThinkingLevel(thinkingLevel);
	settingsManager.setEnableSkillCommands(true);
	await settingsManager.flush();
}

async function configureApiKeyAuth(options: SetupWizardOptions): Promise<void> {
	const providers = uniqueProviders(options.modelRegistry.getAll());
	const provider = await selectProvider(
		options.modelRegistry,
		options.prompter,
		providers,
		"Choose an API key provider:",
		"api_key",
	);
	if (!provider) {
		return;
	}

	const providerName = options.modelRegistry.getProviderDisplayName(provider);
	if (!options.force && options.authStorage.has(provider)) {
		const replace = await options.prompter.confirm(
			`A stored credential already exists for ${providerName}. Replace it?`,
			false,
		);
		if (!replace) {
			await configureModelDefaults(provider, options.modelRegistry, options.settingsManager, options.prompter);
			return;
		}
	}

	const apiKey = await options.prompter.input(`Paste API key for ${providerName}:`);
	options.authStorage.set(provider, { type: "api_key", key: apiKey });
	options.modelRegistry.refresh();
	await configureModelDefaults(provider, options.modelRegistry, options.settingsManager, options.prompter);
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
	await configureModelDefaults(provider, options.modelRegistry, options.settingsManager, options.prompter);
	options.prompter.info(`Launch Morgan and run /login ${provider} to finish subscription authentication.`);
}

async function configureAuthAndModel(options: SetupWizardOptions): Promise<void> {
	const hasDefaults = !!options.settingsManager.getDefaultProvider() && !!options.settingsManager.getDefaultModel();
	if (hasDefaults && !options.force) {
		options.prompter.info("Existing default model configuration found. Use `morgan setup --force` to change it.");
		return;
	}

	const authChoice = await options.prompter.select<AuthChoice>(
		"Choose authentication setup:",
		[
			{ id: "api-key", label: "API key" },
			{ id: "subscription", label: "Subscription login" },
			{ id: "skip", label: "Skip for now" },
		],
		{ defaultId: "api-key" },
	);

	if (authChoice === "api-key") {
		await configureApiKeyAuth(options);
	} else if (authChoice === "subscription") {
		await configureSubscriptionAuth(options);
	} else {
		options.prompter.info("Skipped authentication. Morgan will ask for a model/login when needed.");
	}
}

export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupWizardResult> {
	await configureAuthAndModel(options);
	options.settingsManager.setEnableSkillCommands(true);
	await options.settingsManager.flush();

	const browser = await setupBrowserHarness({
		agentDir: options.agentDir,
		force: options.force,
		prompter: options.prompter,
		runner: options.browserRunner,
	});

	for (const message of browser.messages) {
		if (browser.status === "ready") {
			options.prompter.info(message);
		} else {
			options.prompter.warn(message);
		}
	}

	options.prompter.info("Setup complete.");
	return { launchMorgan: true, browser };
}
