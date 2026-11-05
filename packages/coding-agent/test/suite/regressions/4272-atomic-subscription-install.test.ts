import { expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { StructuredLaneUnavailableError } from "../../../src/core/structured-session-lane.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness } from "../harness.ts";
import { scriptProvider, textReply } from "../structured-lane-support.ts";

// senpi#4272 carry item 10: a session whose Agent was built outside the session layer refuses the structured lane;
// the connection must then install no session subscription at all, never a legacy half without its structured half.
it("installs no legacy subscription when the structured lane is unavailable", async () => {
	const harness = await createHarness();
	const written: object[] = [];
	try {
		const runtime = {
			session: harness.session,
			setRebindSession: () => {},
			dispose: async () => {},
		} as unknown as AgentSessionRuntime;
		const handler = createRpcConnectionHandler(runtime, {
			writeRecord: (record) => written.push(record),
			writeStructured: () => {},
			writeRaw: () => {},
			waitForBackpressure: async () => {},
		});
		await expect(handler.ready).rejects.toBeInstanceOf(StructuredLaneUnavailableError);
		scriptProvider(harness, [textReply("legacy only")]);
		await harness.session.prompt("go");
		expect(written.filter((record) => "type" in record && String(record.type).startsWith("message_"))).toEqual([]);
	} finally {
		harness.cleanup();
	}
});
