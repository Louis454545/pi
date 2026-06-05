import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

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
	close(): void;
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
