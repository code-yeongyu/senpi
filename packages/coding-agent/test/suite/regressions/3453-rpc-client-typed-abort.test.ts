import { afterEach, describe, expect, test } from "vitest";
import { runHostSessionRequest } from "../../../src/modes/rpc/host-session-runner.ts";
import { cleanupHostSessionRigs, rig } from "../host-session-support.ts";

afterEach(cleanupHostSessionRigs);

describe("RpcClient sends a typed abort and reads effect receipts (senpi#3453)", () => {
	test("abort with effectId, awaitIdle and clearQueue answers once the turn stopped, and getEffectStatus finds the receipt", async () => {
		// Given: a real socket host whose model holds the turn open, with one steer queued behind it
		const { client, opened, target, ref } = await rig(true);
		const sessionPath = String(opened.payload.sessionPath);
		await client.openSession({ sessionPath });
		expect(await runHostSessionRequest({ action: "prompt", target, ref, text: "long turn" })).toMatchObject({
			exitCode: 0,
			payload: { disposition: "started" },
		});
		expect(await runHostSessionRequest({ action: "steer", target, ref, text: "queued behind" })).toMatchObject({
			exitCode: 0,
			payload: { disposition: "queued" },
		});

		// When
		const answer = await client.abort({ effectId: "stop-1", awaitIdle: true, clearQueue: true, graceMs: 20_000 });
		const routed = await client.getEffectStatus("stop-1");
		const fromDisk = await client.getEffectStatus("stop-1", { sessionPath });
		const unknown = await client.getEffectStatus("never-sent");

		// Then
		expect(answer).toMatchObject({ effectId: "stop-1", state: "done", stopped: true, idle: true, cleared: 1 });
		expect(routed).toMatchObject({ found: true, effect: { effectId: "stop-1", kind: "abort", state: "done" } });
		expect(fromDisk).toMatchObject({ found: true, effect: { effectId: "stop-1", kind: "abort" } });
		expect(unknown).toEqual({ found: false, searched: "complete" });
	});

	test("a plain abort keeps its old contract: it resolves with nothing", async () => {
		const { client, opened } = await rig();
		await client.openSession({ sessionPath: String(opened.payload.sessionPath) });

		await expect(client.abort()).resolves.toBeUndefined();
	});
});
