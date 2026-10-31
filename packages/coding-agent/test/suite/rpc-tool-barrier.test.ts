import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession } from "./rpc-effect-host-support.ts";

// senpi#3717: the RPC projection of the session tool barrier on a real multi-session host. The faux turn
// is held open until aborted, so the barrier armed by the first prompt stays armed for the release.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

describe("RPC tool barrier", () => {
	it("arms on a prompt that starts its turn, ignores a queued one, and releases idempotently", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const info = await client.request({ type: "get_protocol_info" });
		expect(info.data?.capabilities).toContain("tool_barrier");
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });

		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		const prompt = await client.request({
			type: "prompt",
			sessionId,
			message: "go",
			toolBarrier: { id: "turn-1", deadlineMs: 600_000 },
		});
		expect(prompt).toMatchObject({ success: true, data: { disposition: "started", toolBarrier: "armed" } });
		await started;

		const queued = await client.request({
			type: "prompt",
			sessionId,
			message: "later",
			streamingBehavior: "followUp",
			toolBarrier: { id: "turn-2", deadlineMs: 600_000 },
		});
		expect(queued).toMatchObject({ success: true, data: { disposition: "queued", toolBarrier: "ignored" } });

		const release = { type: "release_tool_barrier", sessionId, barrierId: "turn-1" };
		expect(await client.request(release)).toMatchObject({ success: true, data: { released: true } });
		expect(await client.request(release)).toMatchObject({ success: true, data: { released: false } });
		const neverArmed = { type: "release_tool_barrier", sessionId, barrierId: "turn-2" };
		expect(await client.request(neverArmed)).toMatchObject({ success: true, data: { released: false } });

		const refused = await client.request({ type: "release_tool_barrier", sessionId, barrierId: "" });
		expect(refused).toMatchObject({ success: false });
		expect(String(refused.error)).toMatch(/barrierId must be a non-empty string/);
		const malformed = await client.request({
			type: "prompt",
			sessionId,
			message: "x",
			streamingBehavior: "followUp",
			toolBarrier: { id: "t", deadlineMs: 0 },
		});
		expect(malformed).toMatchObject({ success: false });
		expect(String(malformed.error)).toMatch(/deadlineMs/);

		await client.request({ type: "abort", sessionId });
		await host.stop();
	}, 240_000);
});
