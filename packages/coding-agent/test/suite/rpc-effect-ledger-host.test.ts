import { appendFile, copyFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EFFECT_LOOKUP_CHUNK_BYTES } from "../../src/modes/rpc/effect-transcript-lookup.ts";
import { effectHostWorld, effectOf, openSession } from "./rpc-effect-host-support.ts";

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };
const effectSwitches = (entries: Record<string, unknown>[], effectId: string) =>
	entries.filter((entry) => entry.type === "model_change" && entry.effectId === effectId);

// Real `senpi --mode rpc --listen` hosts over one agent dir; a "restart" is SIGTERM and a fresh process.
describe("RPC effect ledger on a real host", () => {
	it("replays a model switch across a host restart under a new routing handle, and conflicts on another model", async () => {
		await using world = await effectHostWorld();
		// Given: a switch recorded on the first host.
		const first = await world.start();
		const client = await first.connect();
		const info = await client.request({ type: "get_protocol_info" });
		expect(info.data?.capabilities).toContain("effect_ledger");
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		const applied = await client.request({
			type: "set_model",
			sessionId: opened.sessionId,
			provider: "fauxeffect",
			modelId: "faux-2",
			effectId: "m1",
		});
		expect(applied).toMatchObject({ success: true, data: { effectId: "m1", state: "done" } });
		await first.stop();

		// When: a new host process reopens the transcript under another handle and the client retries.
		const second = await world.start();
		const retry = await second.connect();
		await openSession(retry, { cwd: world.cwd, ...MODEL });
		const reopened = await openSession(retry, { sessionPath: opened.sessionPath });
		const replay = await retry.request({
			type: "set_model",
			sessionId: reopened.sessionId,
			provider: "fauxeffect",
			modelId: "faux-2",
			effectId: "m1",
		});
		const conflict = await retry.request({
			type: "set_model",
			sessionId: reopened.sessionId,
			provider: "fauxeffect",
			modelId: "faux-1",
			effectId: "m1",
		});

		// Then
		expect(reopened.sessionId).not.toBe(opened.sessionId);
		expect(replay).toMatchObject({ success: true, data: { replayed: true, state: "done" } });
		expect(conflict).toMatchObject({ success: false, errorCode: "effect_id_conflict" });
		expect(conflict.errorData).toMatchObject({ reason: expect.any(String), action: expect.any(String) });
		expect(effectSwitches(await world.readEntries(opened.sessionPath), "m1")).toHaveLength(1);
		await second.stop();
	}, 240_000);

	it("answers a receipt from disk for an unloaded session, searching the whole file", async () => {
		await using world = await effectHostWorld();
		// Given: a receipt written first, then more than one lookup chunk of later entries.
		const first = await world.start();
		const client = await first.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		await client.request({
			type: "set_model",
			sessionId: opened.sessionId,
			provider: "fauxeffect",
			modelId: "faux-2",
			effectId: "early",
		});
		await first.stop();
		const before = await world.readEntries(opened.sessionPath);
		const padding = JSON.stringify({ type: "custom", customType: "padding", data: "x".repeat(4_000) });
		const lines = Math.ceil((EFFECT_LOOKUP_CHUNK_BYTES * 1.5) / padding.length);
		await appendFile(opened.sessionPath, `${Array.from({ length: lines }, () => padding).join("\n")}\n`);
		const deleted = `${opened.sessionPath}.copy.jsonl`;
		await copyFile(opened.sessionPath, deleted);
		await rm(deleted);

		// When: a new host process that has not loaded the session is asked by path.
		const second = await world.start();
		const reader = await second.connect();
		const found = await reader.request({
			type: "get_effect_status",
			effectId: "early",
			sessionPath: opened.sessionPath,
		});
		const absent = await reader.request({
			type: "get_effect_status",
			effectId: "never",
			sessionPath: opened.sessionPath,
		});
		const unreadable = await reader.request({ type: "get_effect_status", effectId: "early", sessionPath: deleted });
		const sessions = await reader.request({ type: "list_sessions" });

		// Then
		expect(found).toMatchObject({ success: true, data: { found: true } });
		expect(effectOf(found)).toMatchObject({ effectId: "early", kind: "set_model", state: "done" });
		expect(absent).toMatchObject({ success: true, data: { found: false, searched: "complete" } });
		expect(unreadable).toMatchObject({ success: false, errorCode: "transcript_unreadable" });
		expect(unreadable.errorData).toMatchObject({ path: deleted, action: expect.any(String) });
		expect(sessions.data?.sessions).toEqual([]);
		const after = await world.readEntries(opened.sessionPath);
		expect(effectSwitches(after, "early")).toHaveLength(effectSwitches(before, "early").length);
		const reopened = await openSession(reader, { sessionPath: opened.sessionPath });
		const loaded = await reader.request({
			type: "get_effect_status",
			sessionId: reopened.sessionId,
			effectId: "early",
		});
		expect(loaded).toMatchObject({ success: true, data: { found: true } });
		expect(effectOf(loaded)).toMatchObject({
			effectId: "early",
			kind: "set_model",
			state: "done",
			sessionId: reopened.sessionId,
		});
		await second.stop();
	}, 240_000);

	it("seals a running input as interrupted_by_reopen when the host dies mid-turn", async () => {
		await using world = await effectHostWorld();
		// Given: a turn running for an identified prompt, then the host is SIGKILLed.
		const first = await world.start();
		const client = await first.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === opened.sessionId);
		await client.request({ type: "prompt", sessionId: opened.sessionId, message: "run", clientMessageId: "c1" });
		await started;
		await first.kill();

		// When
		const second = await world.start();
		const reader = await second.connect();
		const reopened = await openSession(reader, { sessionPath: opened.sessionPath });
		const status = await reader.request({ type: "get_effect_status", sessionId: reopened.sessionId, effectId: "c1" });

		// Then
		expect(effectOf(status)).toMatchObject({
			kind: "input",
			state: "done",
			outcome: { kind: "interrupted_by_reopen", action: expect.any(String) },
		});
		await second.stop();
	}, 240_000);

	it("tells a late client that another client aborted the turn", async () => {
		await using world = await effectHostWorld();
		// Given: client A's turn is running.
		const host = await world.start();
		const owner = await host.connect();
		const opened = await openSession(owner, { cwd: world.cwd, ...MODEL });
		const ownerReceipt = await owner.request({
			type: "abort",
			sessionId: opened.sessionId,
			effectId: "a-identity",
		});
		const started = owner.wait((record) => record.type === "agent_start" && record.sessionId === opened.sessionId);
		await owner.request({ type: "prompt", sessionId: opened.sessionId, message: "run", clientMessageId: "a-input" });
		await started;
		const idle = owner.wait((record) => record.type === "agent_idle" && record.sessionId === opened.sessionId);

		// When: client B aborts it and client C reads the receipt afterwards.
		const aborter = await host.connect();
		const abortReceipt = await aborter.request({
			type: "abort",
			sessionId: opened.sessionId,
			effectId: "b-abort",
		});
		await idle;
		const late = await host.connect();
		const status = await late.request({
			type: "get_effect_status",
			sessionId: opened.sessionId,
			effectId: "a-input",
		});

		// Then
		expect(effectOf(status)).toMatchObject({
			state: "done",
			outcome: {
				kind: "aborted",
				abortSource: expect.any(String),
				abortedBy: effectOf(abortReceipt)?.by,
			},
		});
		expect(effectOf(abortReceipt)?.by).toMatchObject({ connectionId: expect.any(String) });
		expect(effectOf(abortReceipt)?.by).not.toEqual(effectOf(ownerReceipt)?.by);
		await host.stop();
	}, 240_000);

	it("gives a queued input dropped by new_session a failed receipt in its own transcript", async () => {
		await using world = await effectHostWorld();
		// Given: a steer queued behind a running turn.
		const host = await world.start();
		const client = await host.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === opened.sessionId);
		await client.request({ type: "prompt", sessionId: opened.sessionId, message: "run" });
		await started;
		const queued = await client.request({
			type: "steer",
			sessionId: opened.sessionId,
			message: "later",
			clientMessageId: "s1",
		});
		expect(queued).toMatchObject({ success: true, data: { admission: { state: "queued" } } });

		// When
		const replaced = await client.request({ type: "new_session", sessionId: opened.sessionId });
		const status = await client.request({
			type: "get_effect_status",
			effectId: "s1",
			sessionPath: opened.sessionPath,
		});

		// Then
		expect(replaced).toMatchObject({ success: true, data: { cancelled: false } });
		expect(effectOf(status)).toMatchObject({
			kind: "input",
			state: "failed",
			outcome: { kind: "dropped_by_replace", action: expect.any(String) },
		});
		await host.stop();
	}, 240_000);
});
