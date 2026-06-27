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
	{ name: "export", description: "Export conversation as JSONL" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "reset", description: "Reset the global conversation" },
	{ name: "compact", description: "Manually compact the conversation context" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	...(process.env.MORGAN_DEV_RELOAD_EXIT_CODE
		? [{ name: "dev-reload", description: "Restart the source dev runner" }]
		: []),
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
