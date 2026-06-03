import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string } & Record<string, unknown>) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient clone", () => {
	it("sends the clone RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone();

		expect(send).toHaveBeenCalledWith({ type: "clone" });
		expect(result).toEqual({ cancelled: false });
	});

	it("sends model cycle direction and bash context options", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async (command: { type: string } & Record<string, unknown>) => {
			if (command.type === "cycle_model") {
				return {
					type: "response",
					command: "cycle_model",
					success: true,
					data: { model: { provider: "test", id: "beta" }, thinkingLevel: "off", isScoped: false },
				};
			}
			return {
				type: "response",
				command: "bash",
				success: true,
				data: { output: "ok\n", exitCode: 0, cancelled: false, truncated: false },
			};
		});
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		await client.cycleModel("backward");
		await client.bash("echo ok", { excludeFromContext: true });
		await client.reload();

		expect(send).toHaveBeenNthCalledWith(1, { type: "cycle_model", direction: "backward" });
		expect(send).toHaveBeenNthCalledWith(2, { type: "bash", command: "echo ok", excludeFromContext: true });
		expect(send).toHaveBeenNthCalledWith(3, { type: "reload" });
	});
});
