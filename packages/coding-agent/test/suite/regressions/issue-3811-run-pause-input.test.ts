import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptTemplate } from "../../../src/core/prompt-templates.ts";
import {
	type ResumeFixture,
	resumeFixture,
	runRef,
	settle,
	settlesWithin,
	stopDuringNextAdmission,
} from "./issue-3811-resume-support.ts";

const deploy: PromptTemplate = {
	name: "deploy",
	description: "Deploy a service",
	content: "Deploy $1 to production carefully",
	sourceInfo: { path: "test", source: "test", scope: "temporary", origin: "top-level" },
	filePath: "/fixture/deploy.md",
};

async function textFixture(options: { prompts?: PromptTemplate[] } = {}): Promise<ResumeFixture> {
	const fixture = await resumeFixture(options);
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

async function pausedForRun(fixture: ResumeFixture): Promise<number> {
	const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
	if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
	return paused.childSeq;
}

async function resumeRun(fixture: ResumeFixture, childSeq: number): Promise<void> {
	await fixture.h.session.resumeForRun({ parentSessionId: "p", parentPauseSeq: 1, childSeqCutoff: childSeq });
	await settle(fixture);
}

function lastCallText(fixture: ResumeFixture): string {
	return JSON.stringify(fixture.h.faux.getCallLog().at(-1)?.context.messages ?? []);
}

describe("senpi#3811 a run pause holds every person input before anything runs", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("holds a manual-continue '.' typed while the run is paused instead of starting a turn", async () => {
		// Given a child with history, paused for its parent's run
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.prompt("Work on it");
		await settle(fixture);
		const childSeq = await pausedForRun(fixture);
		const callsBefore = fixture.h.faux.state.callCount;

		// When the person types "."
		await fixture.h.session.prompt(".");
		await settle(fixture);

		// Then no model turn started and the input is held for the run Resume
		expect(fixture.h.faux.state.callCount).toBe(callsBefore);
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);

		// And the run Resume, which itself continues the work, consumes it
		await resumeRun(fixture, childSeq);
		expect(fixture.h.faux.state.callCount).toBe(callsBefore + 1);
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
	});

	it("keeps a held '.' held when a newer Stop keeps the run resume turn from starting", async () => {
		// Given a child with history, paused for its parent's run, holding a "."
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.prompt("Work on it");
		await settle(fixture);
		const childSeq = await pausedForRun(fixture);
		await fixture.h.session.prompt(".");
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);

		// When the parent resumes the run and a newer Stop lands while that turn is admitted
		stopDuringNextAdmission(fixture);
		const resumed = await settlesWithin(
			fixture.h.session.resumeForRun({ parentSessionId: "p", parentPauseSeq: 1, childSeqCutoff: childSeq }),
			"resumeForRun",
		);
		await settle(fixture);

		// Then no turn continued the work, so the "." is still held for the next release
		expect(resumed.turnId).toBeUndefined();
		expect(fixture.h.session.paused).toBe(true);
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
	});

	it("holds a prompt template typed while the run is paused and expands it when the run resumes", async () => {
		// Given a child paused for its parent's run, with a prompt template
		const fixture = await textFixture({ prompts: [deploy] });
		fixtures.push(fixture);
		const childSeq = await pausedForRun(fixture);

		// When the person invokes the template
		await fixture.h.session.prompt("/deploy billing");
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
		expect(fixture.h.faux.state.callCount).toBe(0);

		// Then the resumed turn carries the expanded template
		await resumeRun(fixture, childSeq);
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(lastCallText(fixture)).toContain("Deploy billing to production carefully");
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
	});

	it("holds an unknown slash command typed while the run is paused instead of refusing it", async () => {
		// Given a child paused for its parent's run
		const fixture = await textFixture();
		fixtures.push(fixture);
		await pausedForRun(fixture);

		// When the person types a slash command nothing owns
		await fixture.h.session.prompt("/deplyo billing");

		// Then it is held, not rejected and not run
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
		expect(fixture.h.faux.state.callCount).toBe(0);
	});

	it("keeps the child's own Stop when a cancelled prompt is refused while the run is paused", async () => {
		// Given a child paused for its parent's run that also carries its own Stop
		const fixture = await textFixture();
		fixtures.push(fixture);
		await pausedForRun(fixture);
		await fixture.h.session.stop();
		expect(fixture.h.session.holds.map((hold) => hold.kind)).toContain("session_hold");

		// When a prompt arrives already cancelled
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(fixture.h.session.prompt("Use the staging database", { signal: cancelled.signal })).rejects.toThrow(
			"Prompt cancelled before acceptance",
		);

		// Then nothing was held and the Stop is still in place
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
		expect(fixture.h.session.holds.map((hold) => hold.kind)).toContain("session_hold");
	});
});
