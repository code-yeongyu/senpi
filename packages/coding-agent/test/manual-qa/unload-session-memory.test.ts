import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession } from "../suite/rpc-effect-host-support.ts";

// senpi#3225 memory proof (manual QA, SENPI_MANUAL_QA=1): 20 sessions with 1 MiB transcripts are unloaded,
// and the host's own zero-session collection (host_trimmed) reports the footprint it returned. Real elapsed
// time is the subject here (the trimmer runs at most once a minute), which is why this is not a default test.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };
const SESSIONS = 20;
/** Two steers per session keep each one under the 1,000,000-character RPC message limit. */
const STEER_CHARS = 512 * 1024;

type Trimmed = { footprintBeforeMb: number; footprintAfterMb: number; collected: boolean; sessions: number };

describe("unload_session releases memory", () => {
	it("returns the footprint of 20 unloaded 1 MiB sessions", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const baseline = client.wait((record) => record.type === "host_trimmed", 120_000);
		const probe = await openSession(client, { cwd: world.cwd, ...MODEL });
		await client.request({ type: "unload_session", sessionId: probe.sessionId });
		const baselineRecord = await baseline;
		const before = baselineRecord as unknown as Trimmed;
		const baselineAt = Date.now();

		const opened: string[] = [];
		for (let index = 0; index < SESSIONS; index++) {
			const session = await openSession(client, { cwd: world.cwd, ...MODEL });
			for (const part of [0, 1]) {
				const steer = await client.request({
					type: "steer",
					sessionId: session.sessionId,
					message: `${part}`.repeat(STEER_CHARS),
				});
				expect(steer.success).toBe(true);
			}
			opened.push(session.sessionId);
		}
		// `wait` also matches records already received: the after-trim must be a new one.
		const trimmed = client.wait((record) => record.type === "host_trimmed" && record !== baselineRecord, 180_000);
		const last = opened.pop() as string;
		for (const sessionId of opened) {
			const answer = await client.request({ type: "unload_session", sessionId });
			expect(answer.data?.outcome).toBe("unloaded");
		}
		// The host trims at most once a minute and only on the drop to zero sessions: the last unload waits it out.
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, baselineAt + 61_000 - Date.now())));
		expect((await client.request({ type: "unload_session", sessionId: last })).data?.outcome).toBe("unloaded");
		const listed = await client.request({ type: "list_sessions", include_workers: true });
		const evidence0 = process.env.SENPI_QA_EVIDENCE_FILE;
		if (evidence0 !== undefined)
			writeFileSync(
				`${evidence0}.diag`,
				JSON.stringify({ listed: listed.data, types: client.records.map((record) => record.type) }),
			);
		const after = (await trimmed) as unknown as Trimmed;

		const evidence = process.env.SENPI_QA_EVIDENCE_FILE;
		if (evidence !== undefined) writeFileSync(evidence, `${JSON.stringify({ before, after }, null, 2)}\n`);
		expect(after.sessions).toBe(0);
		expect(after.footprintAfterMb).toBeLessThanOrEqual(before.footprintAfterMb * 1.2 + 16);
		await host.stop();
	}, 600_000);
});
