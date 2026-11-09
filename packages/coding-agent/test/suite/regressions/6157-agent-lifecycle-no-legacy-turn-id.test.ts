/**
 * senpi#6157: the engine's `turnId` stays off the legacy wire (#4272 T5). A legacy socket's `agent_start` and
 * `agent_settled` carry no `turnId`, on an ordinary settle and on the settle a session closed mid-turn owes its
 * observers, so their bytes stay what they were before senpi#6151. A real host with faux turns held until aborted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { effectHostWorld, openSession } from "../rpc-effect-host-support.ts";

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

describe.skipIf(process.platform === "win32")(
	"agent lifecycle records carry no turnId on the legacy wire (senpi#6157)",
	() => {
		it("an ordinary run's agent_start and agent_settled carry no turnId", async () => {
			const { created, client } = await world();
			const { sessionId } = await openSession(client, { cwd: created.cwd, ...MODEL });
			const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
			const settled = client.wait((record) => record.type === "agent_settled" && record.sessionId === sessionId);

			await client.request({ type: "prompt", sessionId, message: "go" });
			const start = await started;
			await client.request({ type: "abort", sessionId });
			const settle = await settled;

			expect(typeof start.runId).toBe("string");
			expect(start).not.toHaveProperty("turnId");
			expect(settle).not.toHaveProperty("turnId");
		}, 120_000);

		it("the settle a session closed mid-turn owes carries no turnId either", async () => {
			const { created, client, observer } = await world();
			const { sessionId } = await openSession(client, { cwd: created.cwd, ...MODEL, kind: "worker" });
			const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
			const settled = observer.wait((record) => record.type === "agent_settled" && record.sessionId === sessionId);

			await client.request({ type: "prompt", sessionId, message: "hold this turn open" });
			const start = await started;
			await client.request({ type: "close_session", sessionId });
			const settle = await settled;

			expect(settle).toMatchObject({ reason: "session_closed" });
			expect(start).not.toHaveProperty("turnId");
			expect(settle).not.toHaveProperty("turnId");
		}, 120_000);
	},
);
