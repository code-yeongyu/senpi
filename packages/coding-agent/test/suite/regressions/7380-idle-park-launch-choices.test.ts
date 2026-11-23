/**
 * senpi#7380 (code-yeongyu/oh-my-openagent#14799): a retained session opened without explicit launch choices was
 * parked by the idle sweep with a record that named none of them, although the live session knew all three. A reopen
 * from that record ran under the host defaults, so a session moved to `ask` came back without asking; and a client
 * reopening the parked path cleared the record without taking its choices. The record now carries the live session's
 * model, thinking level and permission preset, and a client reopen of a parked path takes the recorded choices the
 * request omits. The rig's clock is virtual: the idle sweep runs on demand, never on wall time.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupParkHosts, parkedEntry, parkHost, parkScratch, within } from "./7020-live-park-support.ts";

afterEach(cleanupParkHosts);

const TURN_MS = 10_000;
// What `set_permission_preset` runs on the live runtime; the rig's binding forwards no session command.
const moveToAsk = (runtime: { setPermissionPreset(preset: string): void } | undefined): void => {
	if (runtime === undefined) throw new Error("the session has no live runtime");
	runtime.setPermissionPreset("ask");
};
const peer = (id: string) => ({ delivery_id: id, text: "[from lead] go on", deliverAs: "followUp" as const });

describe("an idle-sweep park of a session opened without launch choices", () => {
	it("records the live session's model, thinking level and permission preset", async () => {
		const { dir, daemonDir, sessionPath } = await parkScratch();
		const host = await parkHost(dir, daemonDir);
		const sessionId = await host.open(sessionPath);
		moveToAsk(host.registry.peek(sessionId)?.runtime);
		const model = host.session.model;
		if (model === undefined) throw new Error("the faux session has no model");
		const thinkingLevel = host.session.thinkingLevel;

		await host.idleSweep();

		const entry = await parkedEntry(daemonDir, sessionPath);
		expect(entry.model).toEqual({ provider: model.provider, modelId: model.id });
		expect(entry.thinkingLevel).toBe(thinkingLevel);
		expect(entry.permissionPreset).toBe("ask");
	});

	it("comes back on a restarted host under its recorded preset, reads its history and runs a delivery", async () => {
		const { dir, daemonDir, sessionPath } = await parkScratch();
		const host = await parkHost(dir, daemonDir);
		const sessionId = await host.open(sessionPath);
		moveToAsk(host.registry.peek(sessionId)?.runtime);
		await host.inScope(() => host.session.prompt("first"));
		await host.session.waitForIdle();
		await host.idleSweep();
		await host.dispose();

		const restarted = await parkHost(dir, daemonDir);
		const reopenedId = await restarted.open(sessionPath);
		expect(restarted.registry.peek(reopenedId)?.runtime?.launchProfile?.permissionPreset).toBe("ask");
		expect(
			restarted.session.sessionManager.buildSessionContext().messages.some((message) => message.role === "user"),
		).toBe(true);

		const before = restarted.harness.faux.state.callCount;
		const admitted = restarted.inScope(() => restarted.session.externalAdmission.admit(peer("after-restart")));
		expect(admitted).toMatchObject({ kind: "started" });
		await within(restarted.firstTurn, TURN_MS, "the delivered turn");
		expect(restarted.harness.faux.state.callCount).toBeGreaterThan(before);
	});
});
