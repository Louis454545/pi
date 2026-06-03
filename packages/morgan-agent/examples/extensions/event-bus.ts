/**
 * Inter-extension event bus example.
 *
 * Shows morgan.events for communication between extensions. One extension
 * can emit events that other extensions listen to.
 *
 * Usage: /emit [event-name] [data] - emit an event on the bus
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/morgan-agent";

export default function (morgan: ExtensionAPI) {
	// Store ctx for use in event handler
	let currentCtx: ExtensionContext | undefined;

	morgan.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

	// Listen for events from other extensions
	morgan.events.on("my:notification", (data) => {
		const { message, from } = data as { message: string; from: string };
		currentCtx?.ui.notify(`Event from ${from}: ${message}`, "info");
	});

	// Command to emit events (emits "my:notification" which the listener above receives)
	morgan.registerCommand("emit", {
		description: "Emit my:notification event (usage: /emit message)",
		handler: async (args, _ctx) => {
			const message = args.trim() || "hello";
			morgan.events.emit("my:notification", { message, from: "/emit command" });
			// Listener above will show the notification
		},
	});

	// Example: emit on session start
	morgan.on("session_start", async () => {
		morgan.events.emit("my:notification", {
			message: "Session started",
			from: "event-bus-example",
		});
	});
}
