import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { multiSessionHostCapabilities } from "../../../src/modes/rpc/host-capabilities.ts";
import { parseHostProtocolInfo } from "../../../src/modes/rpc/host-protocol-info.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";
import { reservationHost } from "../rpc-worker-reservation-support.ts";

it.each(["in-process", "worker"] as const)(
	"advertises session_held on the guarded %s host and inventory",
	async (runtime) => {
		const root = await mkdtemp(join(tmpdir(), "held-capability-"));
		try {
			let response: unknown;
			if (runtime === "in-process") {
				await using rig = createInProcessRig(root);
				response = await rig.send("client", { id: "info", type: "get_protocol_info" });
			} else {
				const agentDir = join(root, "agent");
				await mkdir(agentDir);
				const extension = join(root, "empty.mjs");
				await writeFile(extension, "export default () => {};");
				const host = reservationHost(root, agentDir, extension);
				host.connect("client");
				try {
					response = await host.send("client", { id: "info", type: "get_protocol_info" });
				} finally {
					await host.dispose();
				}
			}
			expect(response).toMatchObject({
				success: true,
				data: { mode: "multi", capabilities: expect.arrayContaining(["session_held"]) },
			});
			if (typeof response !== "object" || response === null || !("data" in response))
				throw new Error("Missing protocol response");
			expect(parseHostProtocolInfo(response.data)?.capabilities).toContain("session_held");
			expect(multiSessionHostCapabilities({ warm: runtime === "in-process", negotiated: [] })).toContain(
				"session_held",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it.each([{ capabilities: [] }, { capabilities: ["session_held"] }])(
	"does not advertise an inactive classic guard from client flags $capabilities",
	async ({ capabilities }) => {
		const root = await mkdtemp(join(tmpdir(), "held-classic-capability-"));
		const harness = makeHarness(root);
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink, { capabilities });
		try {
			const response = collected.waitFor((record) => record.id === "info");
			await handler.handleInputLine(JSON.stringify({ id: "info", type: "get_protocol_info" }));
			expect(await response).toMatchObject({
				success: true,
				data: { mode: "classic", capabilities: expect.not.arrayContaining(["session_held"]) },
			});
		} finally {
			await handler.dispose();
			harness.cleanup();
			await rm(root, { recursive: true, force: true });
		}
	},
);
