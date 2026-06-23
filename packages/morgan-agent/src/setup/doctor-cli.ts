import { homedir } from "node:os";
import chalk from "chalk";
import { APP_NAME, getAgentDir, getSettingsPath } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import {
	collectSetupDiagnostics,
	type DiagnosticRunner,
	formatDiagnostic,
	hasFailingDiagnostics,
} from "./diagnostics.ts";

interface DoctorCommandOptions {
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
}

export interface DoctorCommandRuntimeOptions {
	runner?: DiagnosticRunner;
}

function printDoctorHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} doctor

Diagnose Morgan setup, authentication, browser control, and update support.

Options:
  --help, -h   Show this help
`);
}

function parseDoctorCommand(args: string[]): DoctorCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "doctor") {
		return undefined;
	}

	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	for (const arg of rest) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}
	return { help, invalidOption, invalidArgument };
}

export async function handleDoctorCommand(
	args: string[],
	runtimeOptions: DoctorCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parseDoctorCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printDoctorHelp();
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "doctor".`));
		console.error(chalk.dim(`Use "${APP_NAME} doctor --help".`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument} for "doctor".`));
		console.error(chalk.dim(`Use "${APP_NAME} doctor --help".`));
		process.exitCode = 1;
		return true;
	}

	const agentDir = getAgentDir();
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const settingsManager = SettingsManager.create(homedir(), agentDir);
	const diagnostics = await collectSetupDiagnostics({
		agentDir,
		authStorage,
		modelRegistry,
		settingsManager,
		settingsPath: getSettingsPath(),
		runner: runtimeOptions.runner,
	});

	for (const diagnostic of diagnostics) {
		console.log(formatDiagnostic(diagnostic));
	}

	if (hasFailingDiagnostics(diagnostics)) {
		process.exitCode = 1;
	}
	return true;
}
