#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageDir = join(repoRoot, "packages", "morgan-agent");
const tsxBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const rootTsconfig = join(repoRoot, "tsconfig.json");
const cliEntrypoint = join(packageDir, "src", "cli.ts");

const DEV_RELOAD_EXIT_CODE = 75;
const MODEL_SETTINGS_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"];

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getRealAgentDir() {
	return resolve(expandHome(process.env.MORGAN_AGENT_DIR ?? join(homedir(), ".morgan", "agent")));
}

function copyJsonFileIfPresent(source, target) {
	if (!existsSync(source)) return false;
	writeFileSync(target, readFileSync(source, "utf-8"), "utf-8");
	return true;
}

function seedSettings(source, target) {
	if (!existsSync(source)) return false;

	const settings = JSON.parse(readFileSync(source, "utf-8"));
	const seeded = {};
	for (const key of MODEL_SETTINGS_KEYS) {
		if (settings[key] !== undefined) {
			seeded[key] = settings[key];
		}
	}

	if (Object.keys(seeded).length === 0) return false;
	writeFileSync(target, `${JSON.stringify(seeded, null, "\t")}\n`, "utf-8");
	return true;
}

function hasArg(args, name) {
	return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function createSandbox() {
	const root = mkdtempSync(join(tmpdir(), "morgan-dev-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	const realAgentDir = getRealAgentDir();
	const realAuthPath = join(realAgentDir, "auth.json");
	const authPath = join(agentDir, "auth.json");
	const authLinked = linkAuthIfPresent(realAuthPath, authPath);
	const modelsCopied = copyJsonFileIfPresent(join(realAgentDir, "models.json"), join(agentDir, "models.json"));
	const settingsSeeded = seedSettings(join(realAgentDir, "settings.json"), join(agentDir, "settings.json"));

	return { root, agentDir, sessionDir, authLinked, modelsCopied, settingsSeeded };
}

function linkAuthIfPresent(realAuthPath, authPath) {
	if (!existsSync(realAuthPath)) return false;
	symlinkSync(realAuthPath, authPath);
	return true;
}

const forwardedArgs = process.argv.slice(2);
const sandbox = createSandbox();
const launchCwd = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd();
const morganArgs = hasArg(forwardedArgs, "--cwd") ? forwardedArgs : ["--cwd", launchCwd, ...forwardedArgs];
const watchFlag = (process.env.MORGAN_DEV_WATCH ?? "0").toLowerCase();
const watchEnabled = watchFlag !== "0" && watchFlag !== "false" && watchFlag !== "no";

const watchArgs = [
	"watch",
	"--tsconfig",
	rootTsconfig,
	"--include",
	"packages/morgan-agent/src",
	"--include",
	"packages/tui/src",
	"--include",
	"packages/agent/src",
	"--include",
	"packages/ai/src",
	"--exclude",
	"node_modules",
	"--exclude",
	"**/dist/**",
	"--exclude",
	"**/.git/**",
	"--exclude",
	"**/coverage/**",
	cliEntrypoint,
	...morganArgs,
];

const directArgs = ["--tsconfig", rootTsconfig, cliEntrypoint, ...morganArgs];

let cleaned = false;
let child;

function cleanup() {
	if (cleaned) return;
	cleaned = true;
	rmSync(sandbox.root, { recursive: true, force: true });
}

function exitFromChild(code, signal) {
	if (!watchEnabled && code === DEV_RELOAD_EXIT_CODE && !signal) {
		console.error("[morgan-dev] restarting...");
		startChild();
		return;
	}

	cleanup();
	if (signal) {
		const signalNumber = osConstants.signals[signal];
		process.exit(128 + (typeof signalNumber === "number" ? signalNumber : 0));
	}
	process.exit(code ?? 0);
}

console.error(`[morgan-dev] sandbox: ${sandbox.root}`);
console.error(
	`[morgan-dev] real config seed: auth=${sandbox.authLinked ? "linked" : "missing"} models=${sandbox.modelsCopied ? "copied" : "missing"} settings=${sandbox.settingsSeeded ? "seeded" : "empty"}`,
);
if (!watchEnabled) {
	console.error("[morgan-dev] manual reload: save changes, then run /dev-reload in the TUI");
}

function startChild() {
	child = spawn(tsxBin, watchEnabled ? watchArgs : directArgs, {
		cwd: repoRoot,
		env: {
			...process.env,
			MORGAN_AGENT_DIR: sandbox.agentDir,
			MORGAN_SESSION_DIR: sandbox.sessionDir,
			MORGAN_PACKAGE_DIR: packageDir,
			MORGAN_DEV_RELOAD_EXIT_CODE: String(DEV_RELOAD_EXIT_CODE),
			MORGAN_DEV_SANDBOX_DIR: sandbox.root,
		},
		stdio: "inherit",
	});

	child.on("exit", exitFromChild);
	child.on("error", (error) => {
		cleanup();
		console.error(`[morgan-dev] failed to start tsx: ${error.message}`);
		process.exit(1);
	});
}

startChild();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.once(signal, () => {
		if (child && !child.killed) {
			child.kill(signal);
			return;
		}
		cleanup();
		process.exit(1);
	});
}

process.on("exit", cleanup);
