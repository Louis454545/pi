import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export conversation (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import a JSONL file into the global conversation" },
	{ name: "share", description: "Share conversation as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set conversation display name" },
	{ name: "session", description: "Show conversation info and stats" },
	{ name: "schedule", description: "Show project-local schedule status" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current conversation at the current position" },
	{ name: "tree", description: "Navigate conversation tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future conversations" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "reset", description: "Archive and reset the global conversation" },
	{ name: "cwd", description: "Set working context and load project resources" },
	{ name: "compact", description: "Manually compact the conversation context" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	...(process.env.MORGAN_DEV_RELOAD_EXIT_CODE
		? [{ name: "dev-reload", description: "Restart the source dev runner" }]
		: []),
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
