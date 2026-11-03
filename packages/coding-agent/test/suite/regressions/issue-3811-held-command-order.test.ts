import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { releaseQuestionInput } from "../../../src/core/question-input.ts";
import { type ResumeFixture, resumeFixture, runRef, settle, settlesWithin } from "./issue-3811-resume-support.ts";

async function textFixture(): Promise<ResumeFixture> {
	const fixture = await resumeFixture();
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

describe("senpi#3811 held extension commands run in order before the releasing turn", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("finishes a held command before the person's releasing turn starts", async () => {
		// Given a child paused for its parent's run with a command held, and its own newer Stop
		const fixture = await textFixture();
		fixtures.push(fixture);
		const order: string[] = [];
		fixture.api().registerCommand("note", {
			description: "Record a note",
			handler: async (args) => {
				order.push(`command:start ${args}`);
				// One macrotask: every microtask step of a turn admitted alongside this command runs before it ends.
				await new Promise<void>((resolve) => setImmediate(resolve));
				order.push("command:end");
			},
		});
		const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
		if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
		await fixture.h.session.prompt("/note remember staging");
		await fixture.h.session.stop();

		// When the parent resumes the run, which leaves the child's own Stop in place
		const resumed = await fixture.h.session.resumeForRun({
			parentSessionId: "p",
			parentPauseSeq: 1,
			childSeqCutoff: paused.childSeq,
		});
		expect(resumed).toMatchObject({ released: true, otherHoldLive: true });
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);

		// And the person's next message releases that Stop
		fixture.h.session.subscribe((event) => {
			if (event.type === "agent_start") order.push("turn:start");
		});
		await fixture.h.session.prompt("Carry on");
		await settle(fixture);

		// Then the held command ran to completion before the person's turn started
		expect(order).toEqual(["command:start remember staging", "command:end", "turn:start"]);
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
	});

	it("finishes a held command before the turn of a person's question answer starts", async () => {
		// Given a child paused for its parent's run with a command held, and its own newer Stop
		const fixture = await textFixture();
		fixtures.push(fixture);
		const order: string[] = [];
		fixture.api().registerCommand("note", {
			description: "Record a note",
			handler: async (args) => {
				order.push(`command:start ${args}`);
				// One macrotask: every microtask step of a turn admitted alongside this command runs before it ends.
				await new Promise<void>((resolve) => setImmediate(resolve));
				order.push("command:end");
			},
		});
		const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
		if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
		await fixture.h.session.prompt("/note remember staging");
		await fixture.h.session.stop();
		const resumed = await fixture.h.session.resumeForRun({
			parentSessionId: "p",
			parentPauseSeq: 1,
			childSeqCutoff: paused.childSeq,
		});
		expect(resumed).toMatchObject({ released: true, otherHoldLive: true });
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);

		// When the person answers a pending question, which releases that Stop (ask-user's answer path)
		const turnStarted = new Promise<void>((resolve) => {
			fixture.h.session.subscribe((event) => {
				if (event.type !== "agent_start") return;
				order.push("turn:start");
				resolve();
			});
		});
		releaseQuestionInput(fixture.h.session.extensionRunner.createContext());
		fixture.api().sendUserMessage("Answer: use staging", { deliverAs: "followUp" });
		await settlesWithin(turnStarted, "the answer's turn");
		await settle(fixture);

		// Then the held command ran to completion before the answer's turn started
		expect(order).toEqual(["command:start remember staging", "command:end", "turn:start"]);
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
		expect(JSON.stringify(fixture.h.session.messages)).toContain("Answer: use staging");
	});

	it("holds a person's question answer under the parent's run pause and runs the held command only at the run Resume", async () => {
		// Given a child paused for its parent's run with a command held
		const fixture = await textFixture();
		fixtures.push(fixture);
		const order: string[] = [];
		fixture.api().registerCommand("note", {
			description: "Record a note",
			handler: async (args) => {
				order.push(`command:start ${args}`);
				await new Promise<void>((resolve) => setImmediate(resolve));
				order.push("command:end");
			},
		});
		fixture.h.session.subscribe((event) => {
			if (event.type === "agent_start") order.push("turn:start");
		});
		const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
		if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
		await fixture.h.session.prompt("/note remember staging");
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);

		// When the person answers a pending question while the run pause is still in place (ask-user's answer path)
		releaseQuestionInput(fixture.h.session.extensionRunner.createContext());
		fixture.api().sendUserMessage("Answer: use staging", { deliverAs: "followUp" });

		// Then nothing left custody: the command is still held and the answer is held beside it
		expect(fixture.h.session.pausedHeldInputCount).toBe(2);
		await settle(fixture);
		expect(order).toEqual([]);
		expect(fixture.h.faux.state.callCount).toBe(0);
		expect(fixture.h.session.pausedHeldInputCount).toBe(2);

		// And the parent's run Resume runs the held command to completion before the turn that delivers the answer
		const resumed = await fixture.h.session.resumeForRun({
			parentSessionId: "p",
			parentPauseSeq: 1,
			childSeqCutoff: paused.childSeq,
		});
		expect(resumed).toMatchObject({ released: true, otherHoldLive: false });
		await settle(fixture);
		expect(order).toEqual(["command:start remember staging", "command:end", "turn:start"]);
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
		expect(JSON.stringify(fixture.h.session.messages)).toContain("Answer: use staging");
	});
});
