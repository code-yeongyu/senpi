import { afterEach, describe, expect, it } from "vitest";
import { EngineTurnHold, type HoldKind, type SessionHoldEvent } from "../../../src/core/engine-turn-hold.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#6900: a hold added while the session is already paused raised `pauseSeq` with no event, so a client
// that quotes the seq it last saw in `resume_session { expectedSeq }` was refused as `stale` forever.
type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;

function recordingLedger(): { ledger: EngineTurnHold; events: string[] } {
	const events: string[] = [];
	const ledger = new EngineTurnHold(
		[],
		false,
		() => "entry",
		() => {},
		(event: SessionHoldEvent) => {
			if (event.type === "session_paused" || event.type === "session_resumed")
				events.push(`${event.type}:${event.pauseSeq}`);
		},
	);
	return { ledger, events };
}

describe("senpi#6900 every pause seq a client must quote is announced", () => {
	const fixtures: Fixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	async function stoppedSession(): Promise<{
		fixture: Fixture;
		context: () => ExtensionContext;
		announced: number[];
	}> {
		let captured: ExtensionContext | undefined;
		const fixture = await createIdentityHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						captured = ctx;
					});
				},
			],
		});
		fixtures.push(fixture);
		await fixture.session.bindExtensions({ mode: "rpc" });
		const announced: number[] = [];
		fixture.session.subscribe((event) => {
			if (event.type === "session_paused") announced.push(event.pauseSeq);
		});
		const context = () => {
			if (captured === undefined) throw new Error("the extension context was never bound");
			return captured;
		};
		return { fixture, context, announced };
	}

	it("a second Stop while paused announces its seq, and a Resume quoting it releases the session", async () => {
		const { fixture, announced } = await stoppedSession();

		await fixture.session.stop();
		await fixture.session.stop();

		expect(announced).toEqual([1, 2]);
		const { answer, settled } = await fixture.session.beginResume({ expectedSeq: announced.at(-1), mode: "release" });
		await settled;
		expect(answer).toMatchObject({ resumed: true, pauseSeq: 2 });
	});

	it("a run fence after the Stop raises the seq silently, and a Resume quoting the announced seq still releases", async () => {
		const { fixture, context, announced } = await stoppedSession();

		await fixture.session.stop();
		context().fenceRun?.({ kind: "dag", id: "r1" });

		expect(announced).toEqual([1]);
		const { answer, settled } = await fixture.session.beginResume({ expectedSeq: 1, mode: "release" });
		await settled;
		expect(answer).toMatchObject({ resumed: true, pauseSeq: 2 });
	});

	it("a released Stop re-armed while a newer Stop holds the session announces the new seq; fences stay silent", () => {
		const { ledger, events } = recordingLedger();
		// Given Stop #1, released by the user's message
		ledger.addHold("session_hold", { key: "session_hold:1" });
		ledger.releaseAll("input");
		// When Stop #2 lands, the rollback re-arms Stop #1's hold, and a run fence is added
		ledger.addHold("session_hold", { key: "session_hold:2" });
		ledger.abandonRelease();
		ledger.addHold("run_fence", { key: "run_fence:dag:r1", data: { runRef: { kind: "dag", id: "r1" } } });

		// Then every pausing hold is announced, and only the fence's seq stays silent
		expect(events).toEqual(["session_paused:1", "session_resumed:1", "session_paused:2", "session_paused:3"]);
		expect([2, 3, 4, 5].map((seq) => ledger.isCurrentPauseSeq(seq))).toEqual([false, true, true, false]);
	});

	it.each<HoldKind>(["unattended", "inherited_hold"])("a %s hold added while paused announces its seq", (kind) => {
		const { ledger, events } = recordingLedger();
		ledger.addHold("session_hold", { key: "session_hold:1" });
		ledger.addHold(kind);

		expect(events).toEqual(["session_paused:1", "session_paused:2"]);
		expect(ledger.isCurrentPauseSeq(1)).toBe(false);
		expect(ledger.isCurrentPauseSeq(2)).toBe(true);
	});
});
