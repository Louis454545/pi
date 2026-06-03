import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { isBunBinary } from "../../config.ts";
import * as bundledSchedulesApi from "../../schedules.ts";
import type { ScheduleDefinition } from "./api.ts";

const VIRTUAL_MODULES: Record<string, unknown> = {
	"@earendil-works/morgan-agent/schedules": bundledSchedulesApi,
};

let aliases: Record<string, string> | undefined;

function resolveLocalEntry(packageRoot: string, name: string): string {
	const sourcePath = path.join(packageRoot, `${name}.ts`);
	if (fs.existsSync(sourcePath)) {
		return sourcePath;
	}
	return path.join(packageRoot, `${name}.js`);
}

function getAliases(): Record<string, string> {
	if (aliases) {
		return aliases;
	}

	const dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageRoot = path.resolve(dirname, "../..");
	const schedulesEntry = resolveLocalEntry(packageRoot, "schedules");

	aliases = {
		"@earendil-works/morgan-agent/schedules": schedulesEntry,
	};

	return aliases;
}

export async function loadScheduleModule(filePath: string): Promise<ScheduleDefinition> {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});
	const module = await jiti.import(filePath, { default: true });
	return module as ScheduleDefinition;
}
