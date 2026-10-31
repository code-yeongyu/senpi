import { describe, expect, it } from "vitest";
import { effectHostWorld, effectOf, openSession } from "./rpc-effect-host-support.ts";

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

// A graceful stop disposes the session's runtime. That is not a replacement, so a queued input must keep a
// receipt the next host can restore, never `failed { dropped_by_replace }`.
describe("RPC effect ledger across a graceful host stop", () => {
	it("leaves a queued input restorable when the host stops with SIGTERM", async () => {
		await using world = await effectHostWorld();
		// Given: a steer queued behind a running turn, then the host is stopped gracefully.
		const first = await world.start();
		const client = await first.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === opened.sessionId);
		await client.request({ type: "prompt", sessionId: opened.sessionId, message: "run" });
		await started;
		const queued = await client.request({
			type: "steer",
			sessionId: opened.sessionId,
			message: "later",
			clientMessageId: "q1",
		});
		expect(queued).toMatchObject({ success: true, data: { admission: { state: "queued" } } });
		await first.stop();

		// When: a fresh host process reads the receipt from disk.
		const second = await world.start();
		const reader = await second.connect();
		const status = await reader.request({
			type: "get_effect_status",
			effectId: "q1",
			sessionPath: opened.sessionPath,
		});
		await second.stop();

		// Then
		expect(effectOf(status)).toMatchObject({ kind: "input", state: "accepted" });
		expect(effectOf(status)?.outcome).toBeUndefined();
	}, 240_000);
});
