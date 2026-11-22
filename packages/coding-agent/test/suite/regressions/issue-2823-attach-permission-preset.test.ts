/**
 * #2823: an `open_session` that attaches to a live session moves it to the `permissionPreset` it
 * names, from the next tool call on, in both directions; an attach without one keeps the live
 * preset, and an unknown one is treated exactly as `open_session` treats it.
 *
 * Runs the real in-process host core over the real runtime factory (`attach-permission-preset-harness.ts`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { attachHost, disposeAttachHosts, sessionIdOf } from "./attach-permission-preset-harness.ts";

afterEach(disposeAttachHosts);

describe("an attach moves the live session to the permission preset it names (#2823)", () => {
	it("enforces ask from the next tool call after a full-access session is attached with ask, and full-access again after the reverse", async () => {
		const host = await attachHost();
		const sessionId = sessionIdOf(await host.open("first", "full-access"));
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 0, ran: true });

		const attached = await host.open("second", "ask");
		expect(attached?.data).toMatchObject({ sessionId, attached: true });
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 1, ran: false });

		await host.open("second", "full-access");
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 0, ran: true });
	}, 120_000);

	it("keeps the live preset when an attach names none", async () => {
		const host = await attachHost();
		const sessionId = sessionIdOf(await host.open("first", "ask"));
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 1, ran: false });

		expect((await host.open("second"))?.data).toMatchObject({ sessionId, attached: true });
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 1, ran: false });
	}, 120_000);

	it("treats an unknown preset on attach exactly as open does, and a later valid preset takes over", async () => {
		const host = await attachHost();
		const opened = sessionIdOf(await host.open("first", "full-acess", host.otherPath));
		const openOutcome = await host.runBash(opened);
		expect(openOutcome).toMatchObject({ asked: 0, ran: false });
		expect(openOutcome.result).toContain('Permission setup failed: Invalid --permission-preset \\"full-acess\\"');

		const sessionId = sessionIdOf(await host.open("first", "ask"));
		expect((await host.open("second", "full-acess"))?.data).toMatchObject({ sessionId, attached: true });
		expect(await host.runBash(sessionId)).toEqual(openOutcome);

		await host.open("second", "full-access");
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 0, ran: true });
	}, 120_000);
});
