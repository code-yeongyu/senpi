import { afterEach, describe, expect, it } from "vitest";
import {
	type ResumeFixture,
	resumeFixture,
	runRef,
	settle,
	settlesWithin,
	stopDuringNextAdmission,
} from "./issue-3811-resume-support.ts";

async function stopped(fixture: ResumeFixture): Promise<void> {
	const toolStarted = fixture.toolStarted();
	const prompt = fixture.h.session.prompt("Work on it");
	await toolStarted;
	const stop = fixture.h.session.stop();
	fixture.releaseTool();
	await Promise.all([prompt, stop]);
	await settle(fixture);
}

async function pausedForRun(fixture: ResumeFixture): Promise<number> {
	const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
	if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
	return paused.childSeq;
}

describe("senpi#3811 resume settlement", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("answers resume_session with turnStarted false when a newer Stop lands while the resumed turn is admitted", async () => {
		// Given a stopped session whose next turn admission sees a second Stop
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		await stopped(fixture);
		stopDuringNextAdmission(fixture);

		// When the user resumes
		const { answer, settled } = await settlesWithin(fixture.h.session.beginResume({}), "beginResume");
		await settlesWithin(settled, "the resume settlement");

		// Then the resume answers without a turn and the newer Stop keeps the session paused
		expect(answer).toMatchObject({ resumed: true, turnStarted: false });
		expect(fixture.h.session.paused).toBe(true);
		expect(fixture.h.faux.state.callCount).toBe(1);
	});

	it("answers resume_for_run without a turn id when a newer Stop lands while the resumed turn is admitted", async () => {
		// Given a child paused for its parent's run whose next turn admission sees a Stop
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const childSeq = await pausedForRun(fixture);
		stopDuringNextAdmission(fixture);

		// When the parent resumes the run
		const resumed = await settlesWithin(
			fixture.h.session.resumeForRun({ parentSessionId: "p", parentPauseSeq: 1, childSeqCutoff: childSeq }),
			"resumeForRun",
		);
		await settle(fixture);

		// Then the release is answered with no turn and the Stop keeps the child paused
		expect(resumed).toMatchObject({ released: true });
		expect(resumed.turnId).toBeUndefined();
		expect(fixture.h.session.paused).toBe(true);
		expect(fixture.h.faux.state.callCount).toBe(0);
	});

	it("keeps held input held when a Stop interrupts the turn a run resume started", async () => {
		// Given a child paused for its parent's run with relayed guidance held
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const childSeq = await pausedForRun(fixture);
		fixture.h.session.holdInput({ inputId: "g1", revision: 0, text: "Use the staging database" });

		// When the run resumes and the user stops the resumed turn while its tool runs
		const toolStarted = fixture.toolStarted();
		const resumed = await fixture.h.session.resumeForRun({
			parentSessionId: "p",
			parentPauseSeq: 1,
			childSeqCutoff: childSeq,
		});
		await toolStarted;
		const stop = fixture.h.session.stop();
		fixture.releaseTool();
		await stop;
		await settle(fixture);

		// Then the guidance was not consumed by the stopped turn
		expect(resumed.turnId).toBeDefined();
		expect(fixture.h.session.paused).toBe(true);
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
	});

	it("releases an unattended hold in release mode", async () => {
		// Given an unattended session held by nothing but its unattended hold
		const fixture = await resumeFixture({ unattended: true });
		fixtures.push(fixture);
		expect(fixture.h.session.holds.map((hold) => hold.kind)).toEqual(["unattended"]);

		// When the user releases it without a turn
		const answer = await settlesWithin(
			fixture.h.session.resumeSessionRequest({ mode: "release" }),
			"resume_session release",
		);

		// Then it answers resumed only because the session is no longer paused
		expect(answer).toMatchObject({ resumed: true, turnStarted: false });
		expect(fixture.h.session.paused).toBe(false);
		expect(fixture.h.faux.state.callCount).toBe(0);
	});

	it("attends the session when release mode frees an unattended hold, like a person's input", async () => {
		// Given an unattended session whose notices reach the UI
		const notices: string[] = [];
		const fixture = await resumeFixture({ unattended: true, notify: (message) => notices.push(message) });
		fixtures.push(fixture);

		// When the user releases it, later stops it, and a background wake arrives
		await settlesWithin(fixture.h.session.resumeSessionRequest({ mode: "release" }), "resume_session release");
		await fixture.h.session.stop();
		notices.length = 0;
		fixture
			.api()
			.sendMessage(
				{ customType: "senpi-monitor:probe", content: "background wake", display: false },
				{ triggerTurn: true },
			);
		await settle(fixture);

		// Then the wake is held without the unattended-session notice: the session is attended
		expect(fixture.h.faux.state.callCount).toBe(0);
		expect(fixture.h.session.paused).toBe(true);
		expect(notices).toEqual([]);
	});
});
