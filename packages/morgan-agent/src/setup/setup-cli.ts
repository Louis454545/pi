import { setKeybindings } from "@earendil-works/morgan-tui";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";
import { SetupCancelledError, TuiSetupPrompter } from "./prompter.ts";
import { runSetupWizard } from "./setup-wizard.ts";

export interface SetupCommandResult {
	handled: boolean;
	launchArgs?: string[];
}

interface SetupCommandOptions {
	force: boolean;
	noLaunch: boolean;
	help: boolean;
	invalidOption?: string;
}

function printSetupHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} setup [--force] [--no-launch]

Configure Morgan's global defaults and bundled capabilities.

Options:
  --force       Re-run setup steps even when settings already exist
  --no-launch   Do not start Morgan after setup
`);
}

function parseSetupCommand(args: string[]): SetupCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "setup") {
		return undefined;
	}

	let force = false;
	let noLaunch = false;
	let help = false;
	let invalidOption: string | undefined;

	for (const arg of rest) {
		if (arg === "--force") {
			force = true;
		} else if (arg === "--no-launch") {
			noLaunch = true;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else {
			invalidOption = invalidOption ?? arg;
		}
	}

	return { force, noLaunch, help, invalidOption };
}

export async function handleSetupCommand(args: string[]): Promise<SetupCommandResult> {
	const options = parseSetupCommand(args);
	if (!options) {
		return { handled: false };
	}

	if (options.help) {
		printSetupHelp();
		return { handled: true };
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "setup".`));
		console.error(chalk.dim(`Use "${APP_NAME} setup --help".`));
		process.exitCode = 1;
		return { handled: true };
	}

	if (!process.stdin.isTTY) {
		console.error(chalk.red("Error: morgan setup requires an interactive terminal."));
		process.exitCode = 1;
		return { handled: true };
	}

	const agentDir = getAgentDir();
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const settingsManager = SettingsManager.create(process.cwd(), agentDir, { includeProjectSettings: false });
	initTheme(settingsManager.getTheme(), true);
	setKeybindings(KeybindingsManager.create());
	const prompter = new TuiSetupPrompter({ authStorage, modelRegistry, settingsManager });

	try {
		await runSetupWizard({
			force: options.force,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
		});
	} catch (error) {
		if (error instanceof SetupCancelledError) {
			process.exitCode = 1;
			return { handled: true };
		}
		throw error;
	} finally {
		prompter.close();
		stopThemeWatcher();
	}

	if (options.noLaunch) {
		return { handled: true };
	}
	return { handled: true, launchArgs: [] };
}
