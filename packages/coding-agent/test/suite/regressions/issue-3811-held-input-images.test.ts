import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	image,
	type ResumeFixture,
	resumeFixture,
	runRef,
	settle,
	stopDuringNextAdmission,
} from "./issue-3811-resume-support.ts";

async function textFixture(): Promise<ResumeFixture> {
	const fixture = await resumeFixture();
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

async function pausedForRun(fixture: ResumeFixture): Promise<number> {
	const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
	if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
	return paused.childSeq;
}

function deliveredImages(fixture: ResumeFixture): number {
	const lastCall = fixture.h.faux.getCallLog().at(-1);
	return JSON.stringify(lastCall?.context.messages ?? []).split(image.data).length - 1;
}

describe("senpi#3811 held human input keeps what the person sent", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("delivers the image of a prompt held while the run is paused when the run resumes", async () => {
		// Given a child paused for its parent's run
		const fixture = await textFixture();
		fixtures.push(fixture);
		const childSeq = await pausedForRun(fixture);

		// When the person sends a prompt with an image, and the parent resumes the run
		await fixture.h.session.prompt("Look at this screenshot", { images: [image] });
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
		await fixture.h.session.resumeForRun({ parentSessionId: "p", parentPauseSeq: 1, childSeqCutoff: childSeq });
		await settle(fixture);

		// Then the resumed turn carries the text and the image to the model
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(JSON.stringify(fixture.h.faux.getCallLog().at(-1)?.context.messages)).toContain("Look at this screenshot");
		expect(deliveredImages(fixture)).toBe(1);
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
	});

	it("delivers the image of a prompt a newer Stop turned into held input", async () => {
		// Given a prompt whose admission sees a Stop
		const fixture = await textFixture();
		fixtures.push(fixture);
		stopDuringNextAdmission(fixture);

		// When the person sends it with an image, then releases the Stop with another message
		await fixture.h.session.prompt("Look at this screenshot", { images: [image] });
		await settle(fixture);
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
		expect(fixture.h.faux.state.callCount).toBe(0);
		await fixture.h.session.prompt("Go");
		await settle(fixture);

		// Then the releasing turn carries the held image
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(deliveredImages(fixture)).toBe(1);
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
	});

	it("holds a replayed client message once while the run is paused", async () => {
		// Given a child paused for its parent's run
		const fixture = await textFixture();
		fixtures.push(fixture);
		await pausedForRun(fixture);

		// When the same client message arrives twice
		await fixture.h.session.prompt("Use the staging database", { clientMessageId: "client-1" });
		await fixture.h.session.prompt("Use the staging database", { clientMessageId: "client-1" });

		// Then it is held once
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
	});

	it("holds an extension command typed while the run is paused and runs it when the run resumes", async () => {
		// Given a child paused for its parent's run and an extension command
		const fixture = await textFixture();
		fixtures.push(fixture);
		const ran: string[] = [];
		fixture.api().registerCommand("note", {
			description: "Record a note",
			handler: async (args) => {
				ran.push(args);
			},
		});
		const childSeq = await pausedForRun(fixture);

		// When the person types the command
		await fixture.h.session.prompt("/note remember staging");

		// Then nothing ran while paused: the command is held
		expect(ran).toEqual([]);
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
		expect(fixture.h.faux.state.callCount).toBe(0);

		// And the run Resume runs it, without handing its raw text to the model
		await fixture.h.session.resumeForRun({ parentSessionId: "p", parentPauseSeq: 1, childSeqCutoff: childSeq });
		await settle(fixture);
		expect(ran).toEqual(["remember staging"]);
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
		expect(JSON.stringify(fixture.h.faux.getCallLog().at(-1)?.context.messages)).not.toContain("/note");
	});
});
