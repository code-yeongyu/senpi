import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { HOSTED_REBUILD_DEADLINE_MS, isStepCommitError } from "@earendil-works/pi-agent-core";
import { type Message, normalizeContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createReferenceDriver, projectHistoryRows, type ReferenceDriver } from "./reference-driver.ts";

const assistantTexts = (messages: readonly AgentMessage[]): string[] =>
	messages.flatMap((message) =>
		message.role === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
	);

describe("CK22 reference hosted session driver (custody 15.1, 15.2)", () => {
	let driver: ReferenceDriver | undefined;

	afterEach(() => {
		driver?.cleanup();
		driver = undefined;
	});

	it("latches and bumps the generation before the rejected commit reaches the session", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")])]);
		driver.inject.nextCommit("reject");
		const seen: Array<{ type: string; generation: number }> = [];
		driver.session.subscribe((event) => {
			seen.push({ type: event.type, generation: driver?.generation ?? -1 });
		});

		await driver.session.prompt("go").catch((error: unknown) => {
			if (!isStepCommitError(error)) throw error;
		});

		expect(driver.latchHistory).toMatchObject([
			{ stepId: "step-1", code: "storage_unavailable", generationAfter: 2 },
		]);
		const settled = seen.filter((entry) => entry.type === "agent_settled");
		expect(settled.length).toBeGreaterThan(0);
		expect(settled.every((entry) => entry.generation === 2)).toBe(true);
	});

	it("refuses a provider call from the discarded instance and dials nothing", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("never")])]);
		driver.inject.nextCommit("reject");
		const oldSession = driver.session;
		await driver.prompt("go");
		const providerCalls = driver.counters.providerCalls;
		const refusals = driver.counters.refusals;
		const rows = driver.rows.length;

		await oldSession.prompt("retry from the old instance").catch(() => undefined);

		expect(driver.counters.refusals).toBeGreaterThan(refusals);
		expect(driver.counters.providerCalls).toBe(providerCalls);
		expect(driver.rows).toHaveLength(rows);
	});

	it("rebuilds from durable history: the rebuilt state equals the projected rows and lacks the uncommitted message", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([
			fauxAssistantMessage([fauxText("kept")]),
			fauxAssistantMessage([fauxText("lost")]),
			fauxAssistantMessage([fauxText("redialed")]),
		]);
		await driver.prompt("first");
		driver.inject.nextCommit("reject");
		const oldSession = driver.session;

		await driver.prompt("second");

		expect(driver.rebuilds).toBe(1);
		expect(driver.session).not.toBe(oldSession);
		expect(driver.session.agent.state.messages).toEqual(projectHistoryRows(driver.rows));
		expect(assistantTexts(driver.session.agent.state.messages)).toEqual(["kept", "redialed"]);
		expect(assistantTexts(oldSession.agent.state.messages)).toContain("lost");
	});

	it("keeps queued input in the always-on inbox across a latch and delivers it once after the rebuild", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("answered")])]);
		driver.inject.nextCommit("reject");

		await driver.followUp("later");
		expect(driver.inbox.map((entry) => ({ text: entry.text, consumedBy: entry.consumedBy }))).toEqual([
			{ text: "later", consumedBy: undefined },
		]);
		const oldSession = driver.session;

		await driver.prompt("go");
		await driver.settle();
		const refusals = driver.counters.refusals;
		await oldSession.agent.continue().catch(() => undefined);

		expect(driver.counters.refusals).toBeGreaterThan(refusals);
		const laterRows = driver.rows.filter(
			(row) => row.message.role === "user" && JSON.stringify(row.message.content).includes("later"),
		);
		expect(laterRows).toHaveLength(1);

		expect(driver.rebuilds).toBe(1);
		expect(driver.inbox.map((entry) => entry.consumedBy)).toEqual([2]);
		expect(driver.counters.drainedBy).toEqual([2]);
		const sawLater = driver
			.callLog()
			.filter((call) =>
				call.context.messages.some(
					(message) =>
						message.role === "user" &&
						(typeof message.content === "string"
							? message.content === "later"
							: message.content.some((part) => part.type === "text" && part.text === "later")),
				),
			);
		expect(sawLater).toHaveLength(1);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["answered"]);
	});

	it("keeps the session's own writes in the adapter mirror and out of durable history (S10)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([
			fauxAssistantMessage([fauxText("kept")]),
			fauxAssistantMessage([fauxText("lost")]),
			fauxAssistantMessage([fauxText("redialed")]),
		]);
		await driver.prompt("first");
		driver.inject.nextCommit("reject");
		const appendsBefore = driver.counters.adapterAppendAttempts;

		await driver.prompt("second");

		expect(driver.counters.adapterAppendAttempts).toBeGreaterThan(appendsBefore);
		expect(driver.rows.map((row) => row.kind)).toEqual(["input", "step", "input", "step"]);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["kept", "redialed"]);
	});

	it("loads the rebuilt instance's adapter mirror from durable history (S15 precondition)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("kept")]), fauxAssistantMessage([fauxText("lost")])]);
		await driver.prompt("first");
		driver.inject.nextCommit("reject");

		await driver.prompt("second");

		expect(driver.rebuilds).toBe(1);
		expect(driver.session.sessionManager.buildSessionContext().messages).toEqual(projectHistoryRows(driver.rows));
	});

	it("resolves an ambiguous write that landed by read-back: one row, no latch", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("one")])]);
		driver.inject.nextCommit("ambiguous-landed");

		await driver.prompt("go");

		expect(driver.latchHistory).toEqual([]);
		expect(driver.rebuilds).toBe(0);
		expect(driver.counters.readBacks).toBe(1);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["one"]);
	});

	it("advances the fence on a negative read-back, refuses the late landing and redials to one row", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([
			fauxAssistantMessage([fauxText("first try")]),
			fauxAssistantMessage([fauxText("redialed")]),
		]);
		driver.inject.nextCommit("ambiguous-lost");

		await driver.prompt("go");
		const refusals = driver.counters.refusals;

		expect(driver.latchHistory.map((latch) => latch.code)).toEqual(["ambiguous_unresolved"]);
		expect(driver.counters.readBacks).toBe(1);
		expect(driver.deliverLateLanding()).toBe("refused");
		expect(driver.counters.refusals).toBe(refusals + 1);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["redialed"]);
		expect(driver.counters.providerCalls).toBe(2);
	});

	it("takes the committed path on already_committed, never the in-memory message", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("mine")])]);
		driver.inject.nextCommit("already-committed", fauxAssistantMessage([fauxText("theirs")]));

		await driver.prompt("go");

		expect(driver.latchHistory.map((latch) => latch.code)).toEqual(["already_committed"]);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["theirs"]);
		expect(assistantTexts(driver.session.agent.state.messages)).toEqual(["theirs"]);
		expect(driver.counters.providerCalls).toBe(1);
	});

	it("refuses a commit whose fence was advanced under it as fenced: no row, latch, rebuild", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("stale")]), fauxAssistantMessage([fauxText("fresh")])]);
		driver.inject.advanceFenceBeforeNextCommit();

		await driver.prompt("go");

		expect(driver.latchHistory.map((latch) => latch.code)).toEqual(["fenced"]);
		expect(driver.rebuilds).toBe(1);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["fresh"]);
	});

	it("waits on an unverified epoch without latching and commits once the epoch is confirmed", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("waited")])]);
		driver.inject.epochUnverifiedUntilConfirmed();

		const prompt = driver.prompt("go");
		await driver.epochWaitReached();
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual([]);
		expect(driver.latchHistory).toEqual([]);

		driver.confirmEpoch();
		await prompt;

		expect(driver.latchHistory).toEqual([]);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["waited"]);
	});

	it("never redials a cancelled step: the rebuild commits one synthesized aborted message (W14)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("never")])]);
		driver.inject.cancelNextStep();
		driver.inject.nextCommit("reject");

		await driver.prompt("go");

		expect(driver.rebuilds).toBe(1);
		expect(driver.counters.providerCalls).toBe(1);
		const steps = projectHistoryRows(driver.rows).filter((message) => message.role === "assistant");
		expect(steps.map((message) => (message.role === "assistant" ? message.stopReason : undefined))).toEqual([
			"aborted",
		]);
		expect(driver.session.agent.state.messages).toEqual(projectHistoryRows(driver.rows));
	});

	it("rebuilds within HOSTED_REBUILD_DEADLINE_MS of the latch on the fake clock", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("redialed")])]);
		driver.inject.nextCommit("reject");
		driver.inject.slowRebuildStoreRead(HOSTED_REBUILD_DEADLINE_MS - 1);

		const prompt = driver.prompt("go");
		await driver.rebuildStoreReadStarted();
		driver.clock.advance(HOSTED_REBUILD_DEADLINE_MS - 1);
		await prompt;

		expect(driver.rebuilds).toBe(1);
		expect(driver.counters.rebuildDeadlineMisses).toBe(0);
		expect(driver.latched).toBe(false);
	});

	it("stays latched and retries the rebuild when the store read misses the deadline", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("redialed")])]);
		driver.inject.nextCommit("reject");
		driver.inject.slowRebuildStoreRead(HOSTED_REBUILD_DEADLINE_MS + 1);
		driver.inject.slowRebuildStoreRead(1_000);

		const prompt = driver.prompt("go");
		await driver.rebuildStoreReadStarted(0);
		driver.clock.advance(HOSTED_REBUILD_DEADLINE_MS + 1);
		const first = await Promise.race([
			driver.rebuildStoreReadStarted(1).then(() => "retry read started"),
			prompt.then(() => "rebuilt without a retry read"),
		]);
		expect(first).toBe("retry read started");
		expect(driver.latched).toBe(true);
		expect(driver.counters.rebuildDeadlineMisses).toBe(1);
		expect(driver.rebuilds).toBe(0);
		driver.clock.advance(1_000);
		await prompt;

		expect(driver.counters.rebuildDeadlineMisses).toBe(1);
		expect(driver.rebuilds).toBe(1);
		expect(driver.latched).toBe(false);
		expect(driver.counters.providerCalls).toBe(2);
	});

	it("classifies a commit error by its brand at the commit boundary, not by instanceof (S8d)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([
			fauxAssistantMessage([fauxText("one")]),
			fauxAssistantMessage([fauxText("two")]),
			fauxAssistantMessage([fauxText("three")]),
			fauxAssistantMessage([fauxText("four")]),
		]);
		// A StepCommitError from a second copy of the package: it carries the registry brand, but it is not an
		// instance of this copy's class.
		class SecondCopyStepCommitError extends Error {
			readonly stepId = "second-copy";
			readonly code = "fenced" as const;
			constructor() {
				super("step commit failed: fenced");
				Object.defineProperty(this, Symbol.for("senpi.StepCommitError"), { value: true });
			}
		}
		const secondCopy = new SecondCopyStepCommitError();
		const lookAlike = Object.assign(new Error("step commit failed: fenced"), {
			name: "StepCommitError",
			code: "fenced",
		});

		driver.inject.nextCommitError(secondCopy);
		await driver.prompt("brand");
		driver.inject.nextCommitError(lookAlike);
		await driver.prompt("look-alike");

		expect(driver.classifications.map(({ error, kind, code }) => ({ error, kind, code }))).toEqual([
			{ error: secondCopy, kind: "step-commit-error", code: "fenced" },
			{ error: lookAlike, kind: "store-error", code: "storage_unavailable" },
		]);
		expect(driver.latchHistory.map((latch) => latch.code)).toEqual(["fenced", "storage_unavailable"]);
	});

	it("journals steering and follow-up by id and kind, each consumed exactly once (W10)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([
			fauxAssistantMessage([fauxText("lost")]),
			fauxAssistantMessage([fauxText("after rebuild")]),
			fauxAssistantMessage([fauxText("more")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		driver.inject.nextCommit("reject");

		await driver.enqueue({ id: "m-steer", kind: "steering", text: "steer me" });
		await driver.enqueue({ id: "m-follow", kind: "followUp", text: "follow me" });
		expect(driver.inbox.map(({ id, kind, consumedBy }) => ({ id, kind, consumedBy }))).toEqual([
			{ id: "m-steer", kind: "steering", consumedBy: undefined },
			{ id: "m-follow", kind: "followUp", consumedBy: undefined },
		]);

		await driver.prompt("go");
		await driver.settle();

		expect(driver.rebuilds).toBe(1);
		// Steering joins the first turn before its commit fails (its consume and row are durable then); the follow-up
		// waits for the turn's end, which only the rebuilt generation reaches.
		expect(driver.consumeJournal.map(({ messageId, generation }) => ({ messageId, generation }))).toEqual([
			{ messageId: "m-steer", generation: 1 },
			{ messageId: "m-follow", generation: 2 },
		]);
		for (const text of ["steer me", "follow me"]) {
			const rowsWithText = driver.rows.filter(
				(row) => row.message.role === "user" && JSON.stringify(row.message.content).includes(text),
			);
			expect({ text, rows: rowsWithText.length }).toEqual({ text, rows: 1 });
		}
	});

	it("admits a session-title call as aux, not as a loop step (W12)", async () => {
		driver = await createReferenceDriver({ autoTitleSessions: true });
		driver.setResponses([fauxAssistantMessage([fauxText("answer")]), fauxAssistantMessage([fauxText("A title")])]);

		await driver.prompt("please name this session");
		await driver.settleAux();

		expect(driver.counters.admissions).toBe(1);
		expect(driver.counters.auxAdmissions).toBe(1);
		expect(driver.auxRows.map((row) => row.kind)).toEqual(["aux"]);
		expect(driver.counters.providerCalls).toBe(2);
	});

	it("refuses an aux call from the discarded instance with zero dials (aux-admit-from-discarded-instance)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([
			fauxAssistantMessage([fauxText("lost")]),
			fauxAssistantMessage([fauxText("redialed")]),
			fauxAssistantMessage([fauxText("never")]),
		]);
		driver.inject.nextCommit("reject");
		const oldAgent = driver.session.agent;

		await driver.prompt("go");
		const calls = driver.counters.providerCalls;
		// What a compaction or title started by the old instance after the latch would send.
		const outcome = await Promise.resolve(
			oldAgent.streamFunction(driver.session.model ?? oldAgent.state.model, normalizeContext({ messages: [] })),
		).then(
			() => "dialed",
			() => "refused",
		);

		expect(outcome).toBe("refused");
		expect(driver.counters.auxRefusals).toBe(1);
		expect(driver.counters.auxAdmissions).toBe(0);
		expect(driver.counters.providerCalls).toBe(calls);
	});

	it("stop pressed while latched cancels the latched step: one synthesized abort, no redial (W14, S12)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("never")])]);
		driver.inject.nextCommit("reject");
		driver.inject.slowRebuildStoreRead(1_000);

		const prompt = driver.prompt("go");
		await driver.rebuildStoreReadStarted();
		expect(driver.stop()).toBe("cancelled-latched-step");
		driver.clock.advance(1_000);
		await prompt;

		expect(driver.counters.providerCalls).toBe(1);
		const steps = projectHistoryRows(driver.rows).filter((message) => message.role === "assistant");
		expect(steps.map((message) => (message.role === "assistant" ? message.stopReason : undefined))).toEqual([
			"aborted",
		]);
		expect(driver.stops).toEqual([{ stepId: "step-1", while: "latched" }]);
	});

	it("stop pressed while the rebuild builds its harness still cancels the latched step (W14, review LOW)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("never")])]);
		driver.inject.nextCommit("reject");
		const build = driver.inject.holdNextHarnessBuild();

		const prompt = driver.prompt("go");
		await build.reached;
		expect(driver.stop()).toBe("cancelled-latched-step");
		build.release();
		await prompt;

		expect(driver.counters.providerCalls).toBe(1);
		const steps = projectHistoryRows(driver.rows).filter((message) => message.role === "assistant");
		expect(steps.map((message) => (message.role === "assistant" ? message.stopReason : undefined))).toEqual([
			"aborted",
		]);
	});

	it("records durable input rows in the order the model consumed them (S7 row order = call order)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);

		await driver.enqueue({ id: "s-1", kind: "steering", text: "steer me" });
		await driver.prompt("go");
		await driver.settle();

		const text = (message: AgentMessage | Message): string => {
			if (message.role !== "user") return "";
			const { content } = message;
			return typeof content === "string"
				? content
				: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		};
		const lastCall = driver.callLog().at(-1);
		const modelOrder = (lastCall?.context.messages ?? []).filter((message) => message.role === "user").map(text);
		const rowOrder = projectHistoryRows(driver.rows)
			.filter((message) => message.role === "user")
			.map(text);
		expect(modelOrder).toEqual(["go", "steer me"]);
		expect(rowOrder).toEqual(modelOrder);
	});

	it("admits the post-run queue drain as loop steps, not aux (W12, review MEDIUM-1)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("drained")])]);
		let queued = false;
		const agent = driver.session.agent;
		agent.subscribe((event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			agent.followUp({ role: "user", content: [{ type: "text", text: "after the end" }], timestamp: Date.now() });
		});

		await driver.prompt("go");
		await driver.settle();

		expect(driver.counters.providerCalls).toBe(2);
		expect(driver.counters.auxAdmissions).toBe(0);
		expect(driver.counters.admissions).toBe(2);
	});

	it("admits mid-run threshold compaction as aux, not as a loop step (W12, review MEDIUM-2)", async () => {
		const bigTool: AgentTool = {
			name: "big",
			label: "Big",
			description: "Returns a large result.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "tool output ".repeat(400) }], details: {} }),
		};
		driver = await createReferenceDriver({
			tools: [bigTool],
			models: [{ id: "faux-1", contextWindow: 3_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 600 } },
		});
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("big", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("summary of the big result")]),
			fauxAssistantMessage([fauxText("done")]),
		]);

		await driver.prompt("run big");
		await driver.settle();

		expect(driver.forwarded.filter(({ event }) => event.type === "compaction_end")).toHaveLength(1);
		expect(driver.counters.auxAdmissions).toBe(1);
		expect(driver.counters.admissions).toBe(2);
	});

	it("rebuilds from the latch signal even when the old prompt never returns (S11, C.P4 cond 6)", async () => {
		// An extension handler on the uncommitted step's message_end that never settles wedges the old session's
		// event queue, so its prompt() can never return; the agent loop itself does not wait on it.
		let wedgeArmed = true;
		driver = await createReferenceDriver({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant" || !wedgeArmed) return;
						wedgeArmed = false;
						return new Promise<undefined>(() => {});
					});
				},
			],
		});
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("redialed")])]);
		driver.inject.nextCommit("reject");
		const oldSession = driver.session;

		let oldPromptReturned = false;
		void oldSession.prompt("go").finally(() => {
			oldPromptReturned = true;
		});
		await driver.whenRebuilt();
		await driver.settle();

		expect(oldPromptReturned).toBe(false);
		expect(driver.rebuilds).toBe(1);
		expect(driver.session).not.toBe(oldSession);
		expect(driver.latched).toBe(false);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["redialed"]);
	});

	it("schedules exactly one rebuild per latch", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("redialed")])]);
		driver.inject.nextCommit("reject");

		await driver.prompt("go");
		await driver.whenRebuilt();
		await driver.settle();

		expect(driver.rebuilds).toBe(1);
		expect(driver.counters.providerCalls).toBe(2);
	});

	it("records a failed rebuild; prompt() and whenRebuilt() do not re-throw it", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([
			fauxAssistantMessage([fauxText("lost")]),
			fauxAssistantMessage([fauxText("kept")]),
			fauxAssistantMessage([fauxText("lost again")]),
			fauxAssistantMessage([fauxText("redialed")]),
		]);
		driver.inject.failNextRebuild();
		driver.inject.nextCommit("reject");

		await expect(driver.prompt("first")).resolves.toBeUndefined();
		await expect(driver.whenRebuilt()).resolves.toBeUndefined();
		expect(driver.rebuildFailures).toHaveLength(1);
		expect(driver.rebuilds).toBe(0);
	});

	it("records every tool dispatch in the ledger, once per call (S8a)", async () => {
		let runs = 0;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echoes.",
			parameters: Type.Object({}),
			execute: async () => {
				runs += 1;
				return { content: [{ type: "text", text: "echoed" }], details: {} };
			},
		};
		driver = await createReferenceDriver({ tools: [echo] });
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);

		await driver.prompt("go");
		await driver.settle();

		expect(runs).toBe(1);
		expect(driver.toolLedger.map((entry) => entry.toolName)).toEqual(["echo"]);
	});

	it("never dispatches a tool from an uncommitted step; the redial runs it exactly once (S8a, 2.3)", async () => {
		let runs = 0;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echoes.",
			parameters: Type.Object({}),
			execute: async () => {
				runs += 1;
				return { content: [{ type: "text", text: "echoed" }], details: {} };
			},
		};
		driver = await createReferenceDriver({ tools: [echo] });
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		driver.inject.nextCommit("reject");

		await driver.prompt("go");
		await driver.settle();

		expect(driver.rebuilds).toBe(1);
		expect(runs).toBe(1);
		// Dispatched only on the rebuilt instance, after the latch bumped the generation.
		expect(driver.toolLedger.map((entry) => entry.generation)).toEqual([driver.generation]);
		// The rejected step was never committed: no durable step row carries its id.
		const rejected = driver.latchHistory[0]?.stepId;
		expect(rejected).toBeDefined();
		expect(driver.rows.filter((row) => row.kind === "step" && row.stepId === rejected)).toEqual([]);
	});

	it("pauses a tool call at dispatch and kills it through its signal (S13)", async () => {
		let sawAbort = false;
		const slow: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Waits for its signal.",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				sawAbort = signal?.aborted ?? false;
				return { content: [{ type: "text", text: sawAbort ? "aborted" : "ran" }], details: {} };
			},
		};
		driver = await createReferenceDriver({ tools: [slow] });
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const held = driver.inject.pauseNextTool();

		const run = driver.prompt("go");
		await held.reached;
		held.kill();
		await run;
		await driver.settle();

		expect(sawAbort).toBe(true);
		expect(driver.toolLedger.map((entry) => entry.outcome)).toEqual(["killed"]);
	});

	it("stops an active step: the run is aborted and the stop is recorded (W14, active)", async () => {
		const held: AgentTool = {
			name: "held",
			label: "Held",
			description: "Runs while held.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ran" }], details: {} }),
		};
		driver = await createReferenceDriver({ tools: [held] });
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("held", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("never reached")]),
		]);
		const hold = driver.inject.pauseNextTool();

		const run = driver.prompt("go");
		await hold.reached;
		expect(driver.stop()).toBe("cancelled-active-step");
		await run;
		await driver.settle();

		expect(driver.stops.map((entry) => entry.while)).toEqual(["active"]);
		expect(driver.toolLedger.map((entry) => entry.outcome)).toEqual(["killed"]);
		expect(driver.counters.providerCalls).toBe(1);
	});

	it("records a removal the session made in memory as a tombstone at the next admission (W11)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
		const text = (message: AgentMessage): string =>
			message.role === "user" || message.role === "assistant"
				? typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
				: "";

		await driver.prompt("first");
		await driver.settle();
		// The session drops the first exchange by plain reassignment, as compaction and edits do (no event).
		const agent = driver.session.agent;
		agent.state.messages = agent.state.messages.slice(2);
		await driver.prompt("second");
		await driver.settle();

		expect(projectHistoryRows(driver.rows).map(text)).toEqual(agent.state.messages.map(text));
		expect(driver.rows.some((row) => row.kind === "tombstone")).toBe(true);
	});

	it("evicted after the step committed, before its tool ran: resume runs the tool exactly once, no redial (S8a)", async () => {
		let runs = 0;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echoes.",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				if (!signal?.aborted) runs += 1;
				return { content: [{ type: "text", text: "echoed" }], details: {} };
			},
		};
		driver = await createReferenceDriver({ tools: [echo] });
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("after")]),
		]);
		const hold = driver.inject.pauseNextTool();

		const run = driver.prompt("go").catch(() => undefined);
		await hold.reached;
		await driver.evict();
		await run;
		await driver.resume();
		await driver.settle();

		expect(runs).toBe(1);
		expect(driver.counters.providerCalls).toBe(2);
		expect(driver.toolLedger.map((entry) => entry.outcome)).toEqual(["killed", "ran"]);
	});

	it("killed between a rejection and its rebuild: exactly one replay after resume (S8b)", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("replayed")])]);
		driver.inject.nextCommit("reject");
		const build = driver.inject.holdNextHarnessBuild();

		const prompt = driver.prompt("go").catch(() => undefined);
		await build.reached;
		await driver.evict();
		build.release();
		await prompt;
		await driver.resume();
		await driver.settle();

		expect(driver.counters.providerCalls).toBe(2);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["replayed"]);
	});

	it("eviction with queued steering and no latch: the steering is delivered exactly once after resume (S7 variant)", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echoes.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};
		driver = await createReferenceDriver({ tools: [echo] });
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("after")]),
			fauxAssistantMessage([fauxText("spare")]),
		]);
		const hold = driver.inject.pauseNextTool();

		const run = driver.prompt("go").catch(() => undefined);
		await hold.reached;
		await driver.enqueue({ id: "steer-1", kind: "steering", text: "turn left" });
		await driver.evict();
		await run;
		await driver.resume();
		await driver.settle();

		const seen = (driver.callLog().at(-1)?.context.messages ?? []).filter((message) =>
			JSON.stringify(message).includes("turn left"),
		);
		expect(seen).toHaveLength(1);
	});

	for (const historyStore of ["memory", "sqlite"] as const) {
		for (const fault of ["reject", "already-committed", "ambiguous-landed", "ambiguous-lost"] as const) {
			it(`commit fault ${fault} on the ${historyStore} store leaves exactly one durable step row (2.7 (4) store matrix)`, async () => {
				driver = await createReferenceDriver({ historyStore });
				driver.setResponses([
					fauxAssistantMessage([fauxText("first")]),
					fauxAssistantMessage([fauxText("second")]),
				]);
				if (fault === "already-committed")
					driver.inject.nextCommit(fault, fauxAssistantMessage([fauxText("theirs")]));
				else driver.inject.nextCommit(fault);

				await driver.prompt("go");
				await driver.settle();

				const assistants = projectHistoryRows(driver.rows).filter((message) => message.role === "assistant");
				expect(assistants).toHaveLength(1);
				expect(driver.historyStoreKind).toBe(historyStore);
				expect(driver.storedRowCount()).toBe(driver.rows.length);
			});
		}
	}

	it("never forwards an event the discarded instance emits after the latch", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")])]);
		driver.inject.nextCommit("reject");

		await driver.prompt("go");

		const latchedAt = driver.latchHistory[0]?.forwardedBefore ?? -1;
		const afterLatch = driver.forwarded.slice(latchedAt);
		expect(afterLatch.every((entry) => entry.generation === 2)).toBe(true);
		expect(driver.counters.events).toBe(driver.forwarded.length);
	});
});
