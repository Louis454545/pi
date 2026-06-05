import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import type { Api, Model } from "@earendil-works/morgan-ai";
import { type Component, ProcessTerminal, Spacer, Text, TUI } from "@earendil-works/morgan-tui";
import type { AuthStorage } from "../core/auth-storage.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import { LoginDialogComponent } from "../modes/interactive/components/login-dialog.ts";
import { ModelSelectorComponent } from "../modes/interactive/components/model-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "../modes/interactive/components/oauth-selector.ts";
import { theme } from "../modes/interactive/theme/theme.ts";

export interface SelectOption<T extends string> {
	id: T;
	label: string;
	description?: string;
}

export interface SetupPrompter {
	info(message: string): void;
	warn(message: string): void;
	confirm(message: string, defaultValue?: boolean): Promise<boolean>;
	input(message: string, options?: { allowEmpty?: boolean }): Promise<string>;
	select<T extends string>(message: string, options: SelectOption<T>[], optionsConfig?: { defaultId?: T }): Promise<T>;
	selectAuthProvider?(message: string, providers: AuthSelectorProvider[]): Promise<string | undefined>;
	selectModel?(options: SetupModelSelectOptions): Promise<Model<Api> | undefined>;
	suspend?(): void | Promise<void>;
	resume?(): void | Promise<void>;
	close(): void | Promise<void>;
}

export interface SetupModelSelectOptions {
	provider: string;
	models: Model<Api>[];
	currentModel?: Model<Api>;
}

export class SetupCancelledError extends Error {
	constructor() {
		super("Setup cancelled");
	}
}

interface TuiSetupPrompterOptions {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
}

export class TerminalSetupPrompter implements SetupPrompter {
	private readonly rl = readline.createInterface({ input, output });

	info(message: string): void {
		console.log(message);
	}

	warn(message: string): void {
		console.error(message);
	}

	async confirm(message: string, defaultValue = false): Promise<boolean> {
		const hint = defaultValue ? "Y/n" : "y/N";
		const answer = (await this.rl.question(`${message} [${hint}] `)).trim().toLowerCase();
		if (!answer) {
			return defaultValue;
		}
		return answer === "y" || answer === "yes";
	}

	async input(message: string, options: { allowEmpty?: boolean } = {}): Promise<string> {
		for (;;) {
			const answer = (await this.rl.question(`${message} `)).trim();
			if (answer || options.allowEmpty) {
				return answer;
			}
			this.warn("Enter a value, or press Ctrl+C to cancel.");
		}
	}

	async select<T extends string>(
		message: string,
		options: SelectOption<T>[],
		optionsConfig: { defaultId?: T } = {},
	): Promise<T> {
		if (options.length === 0) {
			throw new Error("Cannot select from an empty option list");
		}

		const defaultIndex = Math.max(
			0,
			optionsConfig.defaultId ? options.findIndex((option) => option.id === optionsConfig.defaultId) : 0,
		);

		for (;;) {
			this.info(message);
			options.forEach((option, index) => {
				const suffix = option.description ? ` - ${option.description}` : "";
				this.info(`  ${index + 1}. ${option.label}${suffix}`);
			});
			const answer = (await this.rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
			if (!answer) {
				return options[defaultIndex].id;
			}
			const selectedIndex = Number.parseInt(answer, 10) - 1;
			const selected = options[selectedIndex];
			if (selected) {
				return selected.id;
			}
			this.warn("Invalid selection.");
		}
	}

	close(): void {
		this.rl.close();
	}
}

export class TuiSetupPrompter implements SetupPrompter {
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly settingsManager: SettingsManager;
	private readonly tui: TUI;
	private readonly messages: Array<{ text: string; warning: boolean }> = [];
	private active = false;

	constructor(options: TuiSetupPrompterOptions) {
		this.authStorage = options.authStorage;
		this.modelRegistry = options.modelRegistry;
		this.settingsManager = options.settingsManager;
		this.tui = new TUI(new ProcessTerminal(), options.settingsManager.getShowHardwareCursor());
		this.tui.setClearOnShrink(options.settingsManager.getClearOnShrink());
		this.resume();
	}

	info(message: string): void {
		this.addMessage(message, false);
	}

	warn(message: string): void {
		this.addMessage(message, true);
	}

	async confirm(message: string, defaultValue = false): Promise<boolean> {
		const yes: SelectOption<"yes"> = { id: "yes", label: "Yes" };
		const no: SelectOption<"no"> = { id: "no", label: "No" };
		const options = defaultValue ? [yes, no] : [no, yes];
		const selected = await this.select(message, options, { defaultId: defaultValue ? "yes" : "no" });
		return selected === "yes";
	}

	async input(message: string, options: { allowEmpty?: boolean } = {}): Promise<string> {
		for (;;) {
			const value = await this.withComponent<string>((resolve, reject) => {
				const dialog = new LoginDialogComponent(
					this.tui,
					"setup",
					() => reject(new SetupCancelledError()),
					"Morgan setup",
					"Morgan setup",
				);
				dialog.showPrompt(message).then(resolve, (error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					reject(message === "Login cancelled" ? new SetupCancelledError() : new Error(message));
				});
				return dialog;
			});
			const trimmed = value.trim();
			if (trimmed || options.allowEmpty) {
				return trimmed;
			}
			this.warn("Enter a value, or press Escape to cancel.");
		}
	}

	async select<T extends string>(
		message: string,
		options: SelectOption<T>[],
		optionsConfig: { defaultId?: T } = {},
	): Promise<T> {
		if (options.length === 0) {
			throw new Error("Cannot select from an empty option list");
		}

		const ordered = [...options];
		if (optionsConfig.defaultId) {
			const defaultIndex = ordered.findIndex((option) => option.id === optionsConfig.defaultId);
			if (defaultIndex > 0) {
				const [defaultOption] = ordered.splice(defaultIndex, 1);
				ordered.unshift(defaultOption);
			}
		}

		const labels = new Map<string, SelectOption<T>>();
		const displays = ordered.map((option, index) => {
			let display = option.description ? `${option.label} - ${option.description}` : option.label;
			if (labels.has(display)) {
				display = `${display} (${option.id || index + 1})`;
			}
			labels.set(display, option);
			return display;
		});

		return await this.withComponent((resolve, reject) => {
			return new ExtensionSelectorComponent(
				message,
				displays,
				(display) => {
					const option = labels.get(display);
					if (option) {
						resolve(option.id);
					}
				},
				() => reject(new SetupCancelledError()),
				{ tui: this.tui },
			);
		});
	}

	async selectAuthProvider(message: string, providers: AuthSelectorProvider[]): Promise<string | undefined> {
		if (providers.length === 0) {
			this.warn("No providers are available.");
			return undefined;
		}
		this.info(message);
		return await this.withComponent((resolve, reject) => {
			return new OAuthSelectorComponent(
				"login",
				this.authStorage,
				providers,
				(providerId) => resolve(providerId),
				() => reject(new SetupCancelledError()),
			);
		});
	}

	async selectModel(options: SetupModelSelectOptions): Promise<Model<Api> | undefined> {
		if (options.models.length === 0) {
			this.warn(`No models found for provider "${options.provider}".`);
			return undefined;
		}
		return await this.withComponent((resolve, reject) => {
			return new ModelSelectorComponent(
				this.tui,
				options.currentModel,
				this.settingsManager,
				this.modelRegistry,
				[],
				(model) => resolve(model as Model<Api>),
				() => reject(new SetupCancelledError()),
				undefined,
				{
					models: options.models,
					hintText: "Choose the default model. Type to filter.",
				},
			);
		});
	}

	async suspend(): Promise<void> {
		if (!this.active) {
			return;
		}
		await this.tui.terminal.drainInput(1000);
		this.tui.stop();
		this.active = false;
	}

	resume(): void {
		if (this.active) {
			return;
		}
		this.renderStatus();
		this.tui.start();
		this.active = true;
	}

	async close(): Promise<void> {
		if (this.active) {
			await this.tui.terminal.drainInput(1000);
			this.tui.stop();
			this.active = false;
		}
	}

	private addMessage(message: string, warning: boolean): void {
		this.messages.push({ text: message, warning });
		while (this.messages.length > 8) {
			this.messages.shift();
		}
		if (this.active) {
			this.renderStatus();
		}
	}

	private renderStatus(): void {
		this.tui.clear();
		this.tui.addChild(new Text(theme.fg("accent", theme.bold("Morgan setup")), 1, 0));
		this.tui.addChild(
			new Text("Configure global defaults in ~/.morgan/agent and prepare bundled capabilities.", 1, 0),
		);
		if (this.messages.length > 0) {
			this.tui.addChild(new Spacer(1));
			for (const message of this.messages) {
				this.tui.addChild(new Text(message.warning ? theme.fg("warning", message.text) : message.text, 1, 0));
			}
		}
		this.tui.addChild(new Spacer(1));
		this.tui.requestRender();
	}

	private async withComponent<T>(
		createComponent: (resolve: (value: T) => void, reject: (error: Error) => void) => Component,
	): Promise<T> {
		this.resume();
		return await new Promise<T>((resolve, reject) => {
			const finish = (value: T): void => {
				this.tui.setFocus(null);
				this.renderStatus();
				resolve(value);
			};
			const fail = (error: Error): void => {
				this.tui.setFocus(null);
				this.renderStatus();
				reject(error);
			};
			const component = createComponent(finish, fail);
			this.renderStatus();
			this.tui.addChild(component);
			this.tui.setFocus(component);
			this.tui.requestRender(true);
		});
	}
}
