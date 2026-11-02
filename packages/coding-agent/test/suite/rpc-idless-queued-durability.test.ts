import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession } from "./rpc-effect-host-support.ts";

// senpi#1971 part 2: a queued input sent without a clientMessageId survives a host restart exactly once.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

type Ordered = { queuedId: string; text: string; clientMessageId?: string };

describe("id-less queued input durability", () => {
	it("restores an id-less steer after a host restart, delivers it once, and never answers the minted id back", async () => {
		await using world = await effectHostWorld();
		const first = await world.start();
		const client = await first.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });

		const steer = await client.request({ type: "steer", sessionId: opened.sessionId, message: "no-id steer" });
		expect(steer).toMatchObject({ success: true, data: { disposition: "queued" } });
		expect(steer.data?.clientMessageId).toBeUndefined();
		expect(steer.data?.admission).toBeUndefined();
		const admissions = (await world.readEntries(opened.sessionPath)).filter(
			(entry) => entry.type === "custom" && entry.customType === "rpc_client_message_admission",
		);
		expect(admissions).toHaveLength(1);
		const minted = (admissions[0]?.data as { clientMessageId?: string; hostMinted?: boolean } | undefined) ?? {};
		expect(minted.hostMinted).toBe(true);
		expect(minted.clientMessageId).toMatch(/^host:/);
		const before = await client.request({ type: "get_state", sessionId: opened.sessionId });
		expect(((before.data?.ordered ?? []) as Ordered[]).map((input) => input.clientMessageId)).toEqual([undefined]);
		await first.stop();

		const second = await world.start();
		const reader = await second.connect();
		await openSession(reader, { cwd: world.cwd, ...MODEL });
		const reopened = await openSession(reader, { sessionPath: opened.sessionPath });
		const state = await reader.request({ type: "get_state", sessionId: reopened.sessionId });
		const ordered = (state.data?.ordered as Ordered[] | undefined) ?? [];
		expect(ordered.map((input) => input.text)).toEqual(["no-id steer"]);
		// The minted id is internal: no client-facing projection carries it, before or after the restart.
		expect(ordered.map((input) => input.clientMessageId)).toEqual([undefined]);

		const queuedStatus = await reader.request({
			type: "get_effect_status",
			sessionId: reopened.sessionId,
			effectId: minted.clientMessageId,
		});
		expect(queuedStatus.data?.effect).toMatchObject({ kind: "input", state: "accepted" });

		const firstRecord = reader.records.length;
		const started = reader.wait((record) => record.type === "agent_start" && record.sessionId === reopened.sessionId);
		await reader.request({ type: "prompt", sessionId: reopened.sessionId, message: "go" });
		await started;
		const idle = reader.wait((record) => record.type === "agent_idle" && record.sessionId === reopened.sessionId);
		await reader.request({ type: "abort", sessionId: reopened.sessionId });
		await idle;
		const delivered = (await world.readEntries(opened.sessionPath)).filter(
			(entry) =>
				entry.type === "message" &&
				JSON.stringify((entry as { message?: unknown }).message ?? {}).includes("no-id steer"),
		);
		expect(delivered).toHaveLength(1);
		// Correlation fields are client-facing: none may name the minted id (the stored user message keeps it).
		const leaked = reader.records
			.slice(firstRecord)
			.filter(
				(record) =>
					String(record.clientMessageId ?? "").startsWith("host:") ||
					JSON.stringify(record.clientMessages ?? []).includes("host:"),
			);
		expect(leaked.map((record) => record.type)).toEqual([]);
		const finalStatus = await reader.request({
			type: "get_effect_status",
			sessionId: reopened.sessionId,
			effectId: minted.clientMessageId,
		});
		expect(finalStatus.data?.effect).toMatchObject({ kind: "input", state: "done" });
		await second.stop();
	}, 240_000);
});
