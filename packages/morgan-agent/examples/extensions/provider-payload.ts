import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/morgan-agent";

export default function (morgan: ExtensionAPI) {
	const logFile = join(process.cwd(), ".morgan", "provider-payload.log");

	morgan.on("before_provider_request", (event) => {
		appendFileSync(logFile, `${JSON.stringify(event.payload, null, 2)}\n\n`, "utf8");

		// Optional: replace the payload instead of only logging it.
		// return { ...event.payload, temperature: 0 };
	});

	morgan.on("after_provider_response", (event) => {
		appendFileSync(logFile, `[${event.status}] ${JSON.stringify(event.headers)}\n\n`, "utf8");
	});
}
