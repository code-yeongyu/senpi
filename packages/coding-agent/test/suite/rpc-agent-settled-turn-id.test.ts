/**
 * oh-my-openagent#12719: a turn end is deduplicated by its `turnId`, so `agent_settled` names the turn it
 * settles - the same id its `agent_start` named - on an ordinary settle and on the settle a session closed
 * mid-turn owes its observers. A real host with faux turns held until aborted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { effectHostWorld, openSession } from "./rpc-effect-host-support.ts";

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 120_000);

async function world() {
	const created = await effectHostWorld();
	cleanups.push(() => created[Symbol.asyncDispose]());
	const host = await created.start();
	cleanups.push(() => host.stop());
	const client = await host.connect();
	const observer = await host.connect();
	return { created, client, observer };
}

describe.skipIf(process.platform === "win32")("agent_settled carries turnId (oh-my-openagent#12719)", () => {
	it("an ordinary settle names the turn its agent_start named", async () => {
		const { created, client } = await world();
		const { sessionId } = await openSession(client, { cwd: created.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		const settled = client.wait((record) => record.type === "agent_settled" && record.sessionId === sessionId);

		await client.request({ type: "prompt", sessionId, message: "go" });
		const start = await started;
		await client.request({ type: "abort", sessionId });
		const settle = await settled;

		expect(typeof start.turnId).toBe("string");
		expect(settle.turnId).toBe(start.turnId);
	}, 120_000);

	it("the settle a session closed mid-turn owes names that turn too", async () => {
		const { created, client, observer } = await world();
		const { sessionId } = await openSession(client, { cwd: created.cwd, ...MODEL, kind: "worker" });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		const settled = observer.wait((record) => record.type === "agent_settled" && record.sessionId === sessionId);

		await client.request({ type: "prompt", sessionId, message: "hold this turn open" });
		const start = await started;
		await client.request({ type: "close_session", sessionId });
		const settle = await settled;

		expect(settle).toMatchObject({ reason: "session_closed" });
		expect(typeof start.turnId).toBe("string");
		expect(settle.turnId).toBe(start.turnId);
	}, 120_000);
});
