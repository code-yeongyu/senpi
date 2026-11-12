/**
 * senpi#6443: a dry run whose effectId the session's effect ledger already holds. The real call with that id replays
 * the recorded answer and judges nothing again, so the dry run answers that replay too; a pre-check that judged the
 * current state would promise an unload the call it stands for then refuses.
 */
import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession, settledTurn } from "./rpc-effect-host-support.ts";

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

describe("unload_session dry run with a recorded effectId (senpi#6443)", () => {
	it("#given an unload refused under an effectId while another client was attached #when that client leaves and a dry run carries the same effectId #then the dry run answers the recorded refusal, as the real call with that id does", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const owner = await host.connect();
		const other = await host.connect();
		const opened = await openSession(owner, { cwd: world.cwd, ...MODEL });
		await settledTurn(owner, opened.sessionId);
		await openSession(other, { sessionPath: opened.sessionPath });
		const unload = { type: "unload_session", sessionId: opened.sessionId, effectId: "recorded-1" };
		expect(await owner.request(unload)).toMatchObject({ data: { outcome: "refused", reason: "attached" } });
		expect(await other.request({ type: "close_session", sessionId: opened.sessionId })).toMatchObject({
			success: true,
		});

		const fresh = await owner.request({ type: "unload_session", sessionId: opened.sessionId, dryRun: true });
		const dry = await owner.request({ ...unload, dryRun: true });
		const real = await owner.request(unload);

		expect(fresh).toMatchObject({ data: { dry_run: true, outcome: "ready" } });
		expect(real).toMatchObject({ data: { outcome: "refused", reason: "attached", effectId: "recorded-1" } });
		expect(dry).toMatchObject({
			data: { dry_run: true, outcome: "refused", reason: "attached", detail: real.data?.detail },
		});
		await host.stop();
	}, 240_000);
});
