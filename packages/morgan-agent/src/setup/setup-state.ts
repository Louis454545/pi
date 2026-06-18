import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SetupStep = "authModel" | "communication" | "skills" | "browser";
export type SetupProfile = "recommended" | "custom";
export type SetupResumeChoice = "resume" | "start-over" | "skip";
export type BrowserSetupChoice = "install" | "later" | "skip";
export type CommunicationSetupChoice = "tui" | "telegram";

export interface SetupState {
	version: 1;
	profile?: SetupProfile;
	completedSteps: SetupStep[];
	browserChoice?: BrowserSetupChoice;
	communicationChoice?: CommunicationSetupChoice;
}

const SETUP_STATE_FILE = "setup-state.json";

function emptyState(): SetupState {
	return { version: 1, completedSteps: [] };
}

function parseSetupState(content: string): SetupState | undefined {
	const parsed = JSON.parse(content) as Partial<SetupState>;
	if (parsed.version !== 1 || !Array.isArray(parsed.completedSteps)) {
		return undefined;
	}
	return {
		version: 1,
		profile: parsed.profile,
		completedSteps: parsed.completedSteps.filter((step): step is SetupStep => {
			return step === "authModel" || step === "communication" || step === "skills" || step === "browser";
		}),
		browserChoice: parsed.browserChoice,
		communicationChoice: parsed.communicationChoice,
	};
}

export class SetupStateStore {
	private readonly path: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, SETUP_STATE_FILE);
	}

	getPath(): string {
		return this.path;
	}

	load(): SetupState | undefined {
		if (!existsSync(this.path)) {
			return undefined;
		}
		try {
			return parseSetupState(readFileSync(this.path, "utf-8"));
		} catch {
			return undefined;
		}
	}

	save(state: SetupState): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	}

	clear(): void {
		rmSync(this.path, { force: true });
	}

	update(update: (state: SetupState) => SetupState): SetupState {
		const next = update(this.load() ?? emptyState());
		this.save(next);
		return next;
	}

	markCompleted(step: SetupStep): void {
		this.update((state) => ({
			...state,
			completedSteps: Array.from(new Set([...state.completedSteps, step])),
		}));
	}
}
