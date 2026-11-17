import { afterEach, describe, expect, it } from "vitest";
import { EngineTurnHold, type SessionHoldEvent } from "../../../src/core/engine-turn-hold.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6900: a hold added while the session is already paused raised `pauseSeq` with no event, so a client
// that quotes the seq it last saw in `resume_session { expectedSeq }` was refused as `stale` forever.
describe("senpi#6900 every pause seq a client must quote is announced", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("a second Stop while paused announces its seq, and a Resume quoting it releases the session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const announced: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "session_paused") announced.push(event.pauseSeq);
		});

		await harness.session.stop();
		await harness.session.stop();

		expect(announced).toEqual([1, 2]);
		const { answer, settled } = await harness.session.beginResume({ expectedSeq: announced.at(-1), mode: "release" });
		await settled;
		expect(answer).toMatchObject({ resumed: true, pauseSeq: 2 });
	});

	it("a released Stop re-armed while a newer Stop holds the session announces the new seq; fences stay silent", () => {
		const events: SessionHoldEvent[] = [];
		const ledger = new EngineTurnHold(
			[],
			false,
			() => "entry",
			() => {},
			(event) => {
				events.push(event);
			},
		);
		// Stop #1, then the user's message releases it (the release an un-admitted input rolls back)
		ledger.addHold("session_hold", { key: "session_hold:1" });
		ledger.releaseAll("input");
		// Stop #2 lands, then the rollback re-arms Stop #1's hold, and a run fence is added
		ledger.addHold("session_hold", { key: "session_hold:2" });
		ledger.abandonRelease();
		ledger.addHold("run_fence", { key: "run_fence:dag:r1", data: { runRef: { kind: "dag", id: "r1" } } });

		expect(
			events.flatMap((event) =>
				event.type === "session_paused" || event.type === "session_resumed" ? [`${event.type}:${event.pauseSeq}`] : [],
			),
		).toEqual(["session_paused:1", "session_resumed:1", "session_paused:2", "session_paused:3"]);
	});
});
