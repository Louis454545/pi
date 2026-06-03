/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   morgan --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/morgan-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(morgan: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = morgan.getSessionName();
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

export default function (morgan: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(morgan));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = morgan.getSessionName();
			const title = session ? `${frame} π - ${session} - ${cwd}` : `${frame} π - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	morgan.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	morgan.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	morgan.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
