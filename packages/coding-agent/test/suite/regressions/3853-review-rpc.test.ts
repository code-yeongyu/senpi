import { afterEach, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { multiSessionHostCapabilities } from "../../../src/modes/rpc/host-capabilities.ts";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import type { Harness } from "../harness.ts";
import { heldHarness, wake } from "./3853-review-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

// senpi#3853 review M8: command reply is admission, not completion of the provider's tool turn.
it("replies to Resume before the released turn ends and advertises support", async () => {
	const { h, entered, release } = await heldHarness();
	harnesses.push(h);
	const runtime = {
		session: h.session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	const replied = Promise.withResolvers<void>();
	const handler = createRpcConnectionHandler(runtime, {
		writeRaw: (chunk) => {
			if (chunk.includes('"id":"resume"')) replied.resolve();
		},
		waitForBackpressure: async () => {},
	});
	try {
		await handler.ready;
		await h.session.sendCustomMessage(wake, { triggerTurn: true });
		const command = handler.handleInputLine(JSON.stringify({ id: "resume", type: "resume_session" }));
		const first = await Promise.race([replied.promise.then(() => "reply"), entered.promise.then(() => "tool")]);
		expect(first).toBe("reply");
		await command;
		await entered.promise;
		expect(h.session.isStreaming).toBe(true);
		release.resolve();
		await h.session.waitForIdle();
		expect(h.faux.state.callCount).toBe(2);
		expect(multiSessionHostCapabilities({ warm: false, toolRuntime: "in-process", negotiated: [] })).toEqual(
			expect.arrayContaining(["resume_session", "attended"]),
		);
	} finally {
		release.resolve();
		await h.session.waitForIdle();
		await handler.dispose();
	}
});

it.each(["session_paused", "session_resumed"])("only delivers %s to the session's attached connections", (type) => {
	const fanout = new SessionEventFanout();
	const connection = { writeRaw: () => {}, waitForBackpressure: async () => {} };
	fanout.registerConnection("owner", connection);
	fanout.registerConnection("other", connection);
	fanout.attachConnectionToSession("owner", "worker");
	expect(fanout.targets("worker", undefined, false, type)).toEqual(["owner"]);
	fanout.unregisterConnection("owner");
	fanout.unregisterConnection("other");
});
