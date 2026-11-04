import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionPendingInputs } from "../../../src/core/pending-input-session.ts";
import type { PendingInputJournal, PendingInputJournalRecord } from "../../../src/core/pending-input-store.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { TurnConflictError } from "../../../src/core/turn-conflict.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#5776: get_state names the running turn, and a prompt steer that carries expectedTurnId reaches only that turn,
// even when the turn ends while the steer is still on its way into the queue.
describe("RPC steer that names its turn", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	/** A session whose first provider call waits for `release`, and whose `input` handler holds the text "Steer". */
	const setup = async () => {
		const inputHeld = Promise.withResolvers<void>();
		const inputRelease = Promise.withResolvers<void>();
		let holdInput = false;
		const commandRuns: string[] = [];
		const fixture = await createIdentityHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("probe", {
						description: "Records that it ran",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
					pi.on("input", async (event) => {
						if (holdInput && event.text === "Steer") {
							inputHeld.resolve();
							await inputRelease.promise;
						}
						return { action: "continue" };
					});
				},
			],
		});
		fixtures.push(fixture);
		fixture.harness.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			fauxAssistantMessage("third answer"),
		]);
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = async (model, context, options) => {
			const gate = release;
			entered.resolve();
			const aborted = new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
			await Promise.race([gate.promise, aborted]);
			return stream(model, context, options);
		};
		const rpc = fixture.bind();
		const runningTurnId = async (): Promise<unknown> =>
			((await rpc.send({ type: "get_state" })).data as { currentTurnId?: unknown }).currentTurnId;
		const startHeldTurn = async (message = "hold"): Promise<unknown> => {
			entered = Promise.withResolvers<void>();
			release = Promise.withResolvers<void>();
			await rpc.send({ type: "prompt", message });
			await entered.promise;
			return runningTurnId();
		};
		return {
			fixture,
			rpc,
			commandRuns,
			runningTurnId,
			startHeldTurn,
			releaseTurn: () => release.resolve(),
			pauseForParentRun: () =>
				fixture.session.pauseForRun({
					parentSessionId: "parent",
					parentPauseSeq: 1,
					runRef: { kind: "task", id: "run-1" },
				}),
			holdSteerInput: () => {
				holdInput = true;
				return { inputHeld: inputHeld.promise, releaseInput: () => inputRelease.resolve() };
			},
		};
	};
	const steer = (expectedTurnId: unknown, extra: object = {}) => ({
		type: "prompt",
		message: "Steer",
		streamingBehavior: "steer",
		expectedTurnId,
		...extra,
	});
	const agentStarts = (rpc: { messages(): readonly { type?: unknown }[] }) =>
		rpc.messages().filter((event) => event.type === "agent_start").length;
	const userTexts = (fixture: Awaited<ReturnType<typeof setup>>["fixture"]) =>
		fixture.session.messages
			.filter((message) => message.role === "user")
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			);

	it("reports no turn id while idle and refuses a steer that names one", async () => {
		const { rpc, runningTurnId } = await setup();
		expect(await runningTurnId()).toBeUndefined();
		const refused = await rpc.send(steer("1"));
		expect(refused).toMatchObject({ success: false, errorCode: "turn_conflict" });
		expect(refused).not.toHaveProperty("errorData");
	});

	it("queues a steer whose expectedTurnId is the running turn, and that turn takes it", async () => {
		const { fixture, rpc, startHeldTurn, releaseTurn } = await setup();
		try {
			const turnId = await startHeldTurn();
			expect(typeof turnId).toBe("string");
			expect(await rpc.send(steer(turnId))).toMatchObject({ success: true, data: { disposition: "queued" } });
		} finally {
			releaseTurn();
		}
		await Promise.all(rpc.handler.pendingPrompts());
		expect(agentStarts(rpc)).toBe(1);
		expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
	});

	it("refuses a steer that names another turn, naming the running one", async () => {
		const { rpc, startHeldTurn, releaseTurn } = await setup();
		try {
			const turnId = await startHeldTurn();
			expect(await rpc.send(steer("999"))).toMatchObject({
				success: false,
				errorCode: "turn_conflict",
				errorData: { currentTurnId: turnId },
			});
		} finally {
			releaseTurn();
		}
		await Promise.all(rpc.handler.pendingPrompts());
	});

	it.each([
		{ identity: "anonymous", extra: {} },
		{ identity: "durable clientMessageId", extra: { clientMessageId: "steer-1" } },
	])("refuses an $identity steer whose turn ended while an input handler held it", async ({ extra }) => {
		const { fixture, rpc, startHeldTurn, releaseTurn, holdSteerInput } = await setup();
		const { inputHeld, releaseInput } = holdSteerInput();
		let answered: Promise<unknown> | undefined;
		try {
			const turnId = await startHeldTurn();
			// The turn check passes here: the steer names the running turn.
			answered = rpc.send(steer(turnId, extra));
			await inputHeld;
			releaseTurn();
			await fixture.session.waitForIdle();
			expect(fixture.session.isStreaming).toBe(false);
		} finally {
			releaseTurn();
			releaseInput();
		}
		expect(await answered).toMatchObject({ success: false, errorCode: "turn_conflict" });
		await Promise.all(rpc.handler.pendingPrompts());
		expect(fixture.session.pendingMessageCount).toBe(0);
		expect(agentStarts(rpc)).toBe(1);
		expect(fixture.harness.getPendingResponseCount()).toBe(2);
	});

	it("refuses a stale id without recording it, so a retry under the same clientMessageId reaches the running turn", async () => {
		const { fixture, rpc, startHeldTurn, releaseTurn } = await setup();
		try {
			const turnId = await startHeldTurn();
			expect(await rpc.send(steer("999", { clientMessageId: "retry-1" }))).toMatchObject({
				errorCode: "turn_conflict",
			});
			expect(await rpc.send(steer(turnId, { clientMessageId: "retry-1" }))).toMatchObject({
				success: true,
				data: { disposition: "queued" },
			});
			expect(fixture.session.pendingMessageCount).toBe(1);
		} finally {
			releaseTurn();
		}
		await Promise.all(rpc.handler.pendingPrompts());
		expect(agentStarts(rpc)).toBe(1);
		expect(userTexts(fixture)).toEqual(["hold", "Steer"]);
	});

	it("lets a steer refused after its turn ended while an input handler held it be sent again under the same clientMessageId", async () => {
		const { fixture, rpc, startHeldTurn, releaseTurn, holdSteerInput } = await setup();
		const { inputHeld, releaseInput } = holdSteerInput();
		let answered: Promise<unknown> | undefined;
		try {
			answered = rpc.send(steer(await startHeldTurn(), { clientMessageId: "retry-2" }));
			await inputHeld;
			releaseTurn();
			await fixture.session.waitForIdle();
		} finally {
			releaseTurn();
			releaseInput();
		}
		expect(await answered).toMatchObject({ errorCode: "turn_conflict" });
		await Promise.all(rpc.handler.pendingPrompts());
		try {
			const nextTurn = await startHeldTurn("hold again");
			expect(await rpc.send(steer(nextTurn, { clientMessageId: "retry-2" }))).toMatchObject({
				success: true,
				data: { disposition: "queued" },
			});
			expect(fixture.session.pendingMessageCount).toBe(1);
		} finally {
			releaseTurn();
		}
		await Promise.all(rpc.handler.pendingPrompts());
		expect(userTexts(fixture)).toEqual(["hold", "hold again", "Steer"]);
	});

	it("refuses a command-text steer that names a stale turn before the command runs", async () => {
		const { rpc, commandRuns, startHeldTurn, releaseTurn } = await setup();
		try {
			await startHeldTurn();
			expect(await rpc.send({ ...steer("999"), message: "/probe now" })).toMatchObject({
				errorCode: "turn_conflict",
			});
		} finally {
			releaseTurn();
		}
		await Promise.all(rpc.handler.pendingPrompts());
		expect(commandRuns).toEqual([]);
	});

	it("refuses a steer on a session its parent run paused instead of holding it for a later turn", async () => {
		const { fixture, rpc, startHeldTurn, releaseTurn, pauseForParentRun } = await setup();
		let turnId: unknown;
		try {
			turnId = await startHeldTurn();
			expect(await pauseForParentRun()).toHaveProperty("childSeq");
		} finally {
			releaseTurn();
		}
		await Promise.all(rpc.handler.pendingPrompts());
		expect(await rpc.send(steer(turnId))).toMatchObject({ success: false, errorCode: "turn_conflict" });
		expect(fixture.session.pendingMessageCount).toBe(0);
		expect(userTexts(fixture)).toEqual(["hold"]);
	});

	it.each([
		{ name: "a non-string id", command: steer(3), error: /expectedTurnId must be a non-empty string/ },
		{
			name: "an id on a follow-up",
			command: { type: "prompt", message: "Later", streamingBehavior: "followUp", expectedTurnId: "1" },
			error: /expectedTurnId applies only to streamingBehavior "steer"/,
		},
	])("refuses $name at the boundary", async ({ command, error }) => {
		const { rpc } = await setup();
		const refused = await rpc.send(command);
		expect(refused).toMatchObject({ success: false });
		expect(String(refused.error)).toMatch(error);
	});
});

describe("pending-input admission of a steer that names its turn", () => {
	/** A store whose journal append ends the named turn when `endTurnOnWrite` is set: the turn ends while the record is written. */
	const store = () => {
		const records: PendingInputJournalRecord[] = [];
		let turnRunning = true;
		let endTurnOnWrite = false;
		const journal: PendingInputJournal = {
			append: async (record) => {
				records.push(record);
				if (endTurnOnWrite) turnRunning = false;
			},
			read: async () => records,
		};
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({
			sessionManager: SessionManager.inMemory(),
			nextQueuedId: () => `q_${++queuedIds}`,
			journal,
		});
		return {
			inputs,
			records,
			refusal: () => (turnRunning ? undefined : new TurnConflictError(undefined)),
			endTurnOnWrite: () => {
				endTurnOnWrite = true;
			},
			startNextTurn: () => {
				turnRunning = true;
				endTurnOnWrite = false;
			},
			endTurn: () => {
				turnRunning = false;
			},
		};
	};
	const steer = { clientMessageId: "s-1", text: "Steer", mode: "steer" } as const;

	it("records nothing for a steer refused before it is written", async () => {
		const { inputs, records, refusal, endTurn } = store();
		endTurn();
		const enqueued: string[] = [];
		await expect(inputs.admit(steer, (id) => enqueued.push(id), refusal)).rejects.toBeInstanceOf(TurnConflictError);
		expect(records).toEqual([]);
		expect(enqueued).toEqual([]);
	});

	it("admits a resend of a steer whose turn ended while its record was written", async () => {
		const { inputs, records, refusal, endTurnOnWrite, startNextTurn } = store();
		endTurnOnWrite();
		const enqueued: string[] = [];
		await expect(inputs.admit(steer, (id) => enqueued.push(id), refusal)).rejects.toBeInstanceOf(TurnConflictError);
		expect(enqueued).toEqual([]);
		expect(records.length).toBe(2);

		startNextTurn();
		const resent = await inputs.admit(steer, (id) => enqueued.push(id), refusal);

		expect(resent?.outcome).toBe("admitted");
		expect(enqueued).toHaveLength(1);
	});
});
