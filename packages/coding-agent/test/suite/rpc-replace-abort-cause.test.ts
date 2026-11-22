import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession } from "./rpc-effect-host-support.ts";

// omo#10112 root: new_session on a busy session aborts its turn before session_replaced; the abort must name the cause.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

describe("RPC replacement abort cause", () => {
	it("names the replacement on the agent_end of a turn new_session aborts, before session_replaced", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		await client.request({ type: "prompt", sessionId, message: "running when replaced" });
		await started;
		const ended = client.wait((record) => record.type === "agent_end" && record.sessionId === sessionId);
		const replaced = client.wait((record) => record.type === "session_replaced" && record.sessionId === sessionId);

		const response = await client.request({ type: "new_session", sessionId });

		expect(response.success).toBe(true);
		const end = await ended;
		const replacement = await replaced;
		expect(end).toMatchObject({
			aborted: true,
			abortCause: { kind: "session_replaced", reason: "new", targetSessionId: replacement.durableSessionId },
		});
		expect(client.records.indexOf(end)).toBeLessThan(client.records.indexOf(replacement));
		await host.stop();
	}, 240_000);

	it("carries no cause on an ordinary abort", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		await client.request({ type: "prompt", sessionId, message: "plain abort" });
		await started;
		const ended = client.wait((record) => record.type === "agent_end" && record.sessionId === sessionId);

		await client.request({ type: "abort", sessionId });

		const end = await ended;
		expect(end.aborted).toBe(true);
		expect(end.abortCause).toBeUndefined();
		await host.stop();
	}, 240_000);
});
