/**
 * Tools Configuration
 *
 * Use tool names to choose which built-in tools are enabled.
 *
 * Tool names are matched against all available tools. Morgan always runs from HOME.
 *
 * For custom tools, see 06-extensions.ts - custom tools are registered via the
 * extensions system using morgan.registerTool().
 */

import { createAgentSession, SessionManager } from "@earendil-works/morgan-agent";

// Read-only mode (no edit/write)
const { session: readOnlySession } = await createAgentSession({
	tools: ["read", "bash"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Read-only session created");
readOnlySession.dispose();

// Custom tool selection
const { session: customToolsSession } = await createAgentSession({
	tools: ["read", "bash", "edit"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom tools session created");
customToolsSession.dispose();

// Pick a specific tool set. Morgan always operates from HOME.
const { session: specificToolsSession } = await createAgentSession({
	tools: ["read", "bash"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Specific tools session created");
specificToolsSession.dispose();
