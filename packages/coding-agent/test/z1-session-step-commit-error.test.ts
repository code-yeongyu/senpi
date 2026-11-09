import { HOSTED_REBUILD_DEADLINE_MS } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createReferenceDriver, projectHistoryRows, type ReferenceDriver } from "./egress/harness/reference-driver.ts";
import { handlerHop, heldHandler, heldResponse } from "./fixtures/faux-provider/step-commit.ts";
import { recoveryHooks, recoveryTool } from "./fixtures/faux-provider/tool-recovery.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

// senpi#5841: section 15 governs. Failure synthesis is allowed; stale effects are not.
// CK22's own tests own individual harness mechanics. These cases combine real session
// consumers with fault boundaries, asynchronous extensions, and independent fused reads.
describe("CK1s hosted step-commit containment", () => {
	const drivers: ReferenceDriver[] = [];
	const fused: Harness[] = [];
	afterEach(() => {
		for (const driver of drivers.splice(0).reverse()) driver.cleanup();
		for (const harness of fused.splice(0).reverse()) harness.cleanup();
	});

	it("S1/S3/S10 resolves the failed prompt but refuses its queued drain and durable/forwarded failure", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		const response = heldResponse(fauxAssistantMessage("uncommitted"));
		driver.setResponses([response.response, fauxAssistantMessage("must not dial")]);
		driver.inject.nextCommit("reject");
		const build = driver.inject.holdNextHarnessBuild();
		const old = driver.session;
		const observed: string[] = [];
		let mirrorWritesAtLatch: number | undefined;
		old.subscribe((event) => {
			if (!driver.latched) return;
			mirrorWritesAtLatch ??= driver.counters.adapterAppendAttempts;
			observed.push(event.type);
		});
		const prompt = old.prompt("input");
		await response.entered;
		await driver.followUp("queued");
		expect(driver.inbox).toEqual([{ id: "followUp-1", kind: "followUp", text: "queued" }]);
		response.release();
		await expect(prompt).resolves.toBeUndefined();
		await old.agent.continueWithQueuedMessages();

		expect(driver.latchHistory).toMatchObject([{ code: "storage_unavailable", generationAfter: 2 }]);
		expect(observed).toContain("agent_settled");
		expect(driver.counters.refusals).toBeGreaterThanOrEqual(1);
		expect(driver.counters.admissions).toBe(1);
		expect(driver.counters.providerCalls).toBe(1);
		expect(driver.rows.map((row) => [row.kind, getMessageText(row.message)])).toEqual([["input", "input"]]);
		expect(driver.forwarded.slice(driver.latchHistory[0]?.forwardedBefore)).toEqual([]);
		expect(driver.inbox).toEqual([{ id: "followUp-1", kind: "followUp", text: "queued" }]);
		// Under C the discarded instance still writes its synthesized failure into the mirror after the latch; the
		// durable rows above stay unchanged, which is the boundary.
		expect(mirrorWritesAtLatch).toBeDefined();
		expect(driver.counters.adapterAppendAttempts).toBeGreaterThan(mirrorWritesAtLatch ?? Number.POSITIVE_INFINITY);
		build.release();
		await driver.whenRebuilt();
	});

	it("S2 rebuilds from committed rows while the discarded instance retains the uncommitted message", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([
			fauxAssistantMessage("committed"),
			fauxAssistantMessage("uncommitted"),
			fauxAssistantMessage("recovered"),
		]);
		await driver.prompt("first");
		const old = driver.session;
		driver.inject.nextCommit("reject");
		await driver.prompt("second");

		expect(driver.rebuilds).toBe(1);
		expect(driver.session).not.toBe(old);
		expect(driver.session.messages.map(getMessageText)).toEqual(["first", "committed", "second", "recovered"]);
		expect(driver.session.agent.state.messages).toEqual(projectHistoryRows(driver.rows));
		expect(old.agent.state.messages.map(getMessageText)).toContain("uncommitted");
	});

	it("S4 refuses the extension-deferred turn claim before the failed prompt settles", async () => {
		let claimed = false;
		let settled = false;
		const claimStarts: boolean[] = [];
		const driver = await createReferenceDriver({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (claimed) return;
						claimed = true;
						pi.sendMessage(
							{ customType: "ck1s-claim", content: "deferred claim", display: false },
							{ triggerTurn: true },
						);
					});
					pi.on("before_agent_start", (event) => {
						if (event.prompt === "deferred claim") claimStarts.push(settled);
					});
				},
			],
		});
		drivers.push(driver);
		driver.setResponses([fauxAssistantMessage("uncommitted"), fauxAssistantMessage("must not dial")]);
		driver.inject.nextCommit("reject");
		const build = driver.inject.holdNextHarnessBuild();
		const old = driver.session;
		await old.prompt("input").then(() => {
			settled = true;
		});
		await old.waitForIdle();

		expect(claimed).toBe(true);
		expect(claimStarts).toEqual([false]);
		expect(driver.counters.refusals).toBeGreaterThanOrEqual(1);
		expect(driver.counters.admissions).toBe(1);
		expect(driver.counters.providerCalls).toBe(1);
		expect(driver.rows.filter((row) => row.kind === "step")).toEqual([]);
		expect(driver.forwarded.slice(driver.latchHistory[0]?.forwardedBefore)).toEqual([]);
		build.release();
		await driver.whenRebuilt();
	});

	it("S5 fences the old instance's overflow compaction, then admits one rebuilt compaction (retry fencing: S14)", async () => {
		const driver = await createReferenceDriver({
			models: [{ id: "faux-1", contextWindow: 20_000 }],
			settings: {
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
				compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 1000 },
			},
		});
		drivers.push(driver);
		const response = heldResponse(
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
		);
		driver.setResponses([
			fauxAssistantMessage("archive ".repeat(11_000)),
			fauxAssistantMessage("second answer"),
			response.response,
			fauxAssistantMessage("recovered"),
			fauxAssistantMessage("compact summary"),
			fauxAssistantMessage("after compaction"),
		]);
		// Faux computes usage from the actual transcript, so build real context
		// beyond the window rather than supplying a usage number it overwrites.
		driver.session.setAutoCompactionEnabled(false);
		await driver.prompt("first question");
		await driver.prompt("second question");
		const old = driver.session;
		driver.inject.nextCommit("reject");
		driver.inject.slowRebuildStoreRead(1);
		const reached = driver.rebuildStoreReadStarted();
		const prompt = driver.prompt("overflowing question ".repeat(24));
		await response.entered;
		old.setAutoCompactionEnabled(true);
		response.release();
		await reached;
		await old.waitForIdle();
		await driver.settleAux();
		expect(driver.latched).toBe(true);
		expect(driver.counters.admissions).toBe(3);
		expect(driver.counters.providerCalls).toBe(3);
		expect(driver.counters.auxAdmissions).toBe(0);
		expect(driver.counters.auxRefusals).toBeGreaterThanOrEqual(1);
		expect(driver.auxRows).toEqual([]);
		driver.clock.advance(1);
		await prompt;
		await driver.settle();
		await driver.settleAux();
		expect(driver.rebuilds).toBe(1);
		expect(driver.counters.admissions).toBe(4);
		expect(driver.counters.providerCalls).toBe(4);
		expect(driver.session.getContextUsage()?.tokens).toBeGreaterThan(20_000);
		// The next natural session admission must perform the due compaction.
		await driver.prompt("after rebuild");
		await driver.settleAux();
		expect(driver.counters.admissions).toBe(5);
		expect(driver.counters.providerCalls).toBe(6);
		expect(driver.counters.auxAdmissions).toBe(1);
		expect(driver.auxRows).toEqual([{ kind: "aux", generation: 2, auxKey: "aux-1" }]);
		expect(driver.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
	});

	for (const handlers of [0, 1, 2, 5]) {
		for (const race of [false, true]) {
			it(`S7/S9 drains each inbox input once under generation 2 with ${handlers} handlers, race=${race}`, async () => {
				const visits: string[] = [];
				const driver = await createReferenceDriver({
					extensionFactories: Array.from({ length: handlers }, (_, i) => (pi) => {
						pi.on("agent_end", async () => {
							await handlerHop(race);
							visits.push(`agent_end:${i}`);
						});
						pi.on("agent_settled", async () => {
							await handlerHop(race);
							visits.push(`agent_settled:${i}`);
						});
					}),
				});
				drivers.push(driver);
				const response = heldResponse(fauxAssistantMessage("uncommitted"));
				driver.setResponses([
					response.response,
					fauxAssistantMessage("replayed input"),
					fauxAssistantMessage("recovered one"),
					fauxAssistantMessage("recovered two"),
				]);
				driver.inject.nextCommit("reject");
				const old = driver.session;
				const prompt = driver.prompt("input");
				await response.entered;
				await driver.followUp("queued one");
				await driver.followUp("queued two");
				response.release();
				await prompt;
				await driver.settle();
				// C parks the failed run. Exercise a late drain explicitly, rather than
				// assuming that this particular provider error auto-retries.
				await old.agent.continueWithQueuedMessages();

				expect(driver.rebuilds).toBe(1);
				expect(driver.counters.refusals).toBeGreaterThanOrEqual(1);
				// One failed call, one replay of that input, then the two queued turns.
				expect(driver.counters.admissions).toBe(4);
				expect(driver.counters.providerCalls).toBe(4);
				expect(driver.counters.drainedBy).toEqual([2, 2]);
				expect(driver.inbox).toEqual([
					{ id: "followUp-1", kind: "followUp", text: "queued one", consumedBy: 2 },
					{ id: "followUp-2", kind: "followUp", text: "queued two", consumedBy: 2 },
				]);
				expect(driver.rows.map((row) => getMessageText(row.message))).toEqual([
					"input",
					"replayed input",
					"queued one",
					"recovered one",
					"queued two",
					"recovered two",
				]);
				for (const text of ["queued one", "queued two"]) {
					expect(
						driver.callLog().filter((call) => getMessageText(call.context.messages.at(-1)) === text),
					).toHaveLength(1);
				}
				expect(
					driver.forwarded.slice(driver.latchHistory[0]?.forwardedBefore).map((entry) => entry.generation),
				).not.toContain(1);
				expect(new Set(visits).size).toBe(handlers * 2);
			});
		}
	}

	it("S7 preserves provider input order across durable consumption and rebuild", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		const response = heldResponse(fauxAssistantMessage("uncommitted"));
		driver.setResponses([
			fauxAssistantMessage("steering answer"),
			response.response,
			fauxAssistantMessage("recovered"),
			fauxAssistantMessage("follow-up answer"),
		]);
		await driver.enqueue({ id: "steer-1", kind: "steering", text: "durable steering" });
		// Commit the steering turn before faulting the next input: replay of an
		// unanswered input is legitimate, but must not redeliver an answered one.
		await driver.prompt("initial input");
		const answeredContext = driver.callLog()[0]?.context.messages.map(getMessageText);
		expect(answeredContext).toEqual(["initial input", "durable steering"]);
		// The durable prefix must preserve the order the provider answered.
		expect(projectHistoryRows(driver.rows).slice(0, 2).map(getMessageText)).toEqual(answeredContext);
		expect(driver.consumeJournal).toEqual([{ messageId: "steer-1", generation: 1, rowIndex: 1 }]);
		const old = driver.session;
		driver.inject.nextCommit("reject");
		const prompt = driver.prompt("fault input");
		try {
			await response.entered;
			await driver.enqueue({ id: "follow-1", kind: "followUp", text: "durable follow-up" });
		} finally {
			response.release();
		}
		await prompt;
		await driver.settle();

		// A leaked producer still owns the discarded session. Its steering drain
		// must fail at consumption, before it appends a row or reaches a provider.
		await old.steer("discarded steering");
		const refusals = driver.counters.refusals;
		await old.agent.continueWithQueuedMessages();
		expect(driver.counters.drainedBy).toEqual([1, 2]);
		expect(driver.counters.refusals).toBe(refusals + 1);
		expect(driver.rebuilds).toBe(1);
		expect(driver.counters.admissions).toBe(4);
		expect(driver.counters.providerCalls).toBe(4);
		expect(driver.consumeJournal).toEqual([
			{ messageId: "steer-1", generation: 1, rowIndex: 1 },
			{ messageId: "follow-1", generation: 2, rowIndex: 5 },
		]);
		expect(driver.inbox).toEqual([
			{ id: "steer-1", kind: "steering", text: "durable steering", consumedBy: 1 },
			{ id: "follow-1", kind: "followUp", text: "durable follow-up", consumedBy: 2 },
		]);
		expect(driver.rows.map((row) => [row.kind, getMessageText(row.message)])).toEqual([
			["input", "initial input"],
			["input", "durable steering"],
			["step", "steering answer"],
			["input", "fault input"],
			["step", "recovered"],
			["input", "durable follow-up"],
			["step", "follow-up answer"],
		]);
		expect(driver.callLog().map((call) => getMessageText(call.context.messages.at(-1)))).toEqual([
			"durable steering",
			"fault input",
			"fault input",
			"durable follow-up",
		]);
		expect(driver.callLog()[2]?.context.messages.map(getMessageText)).toEqual([
			"initial input",
			"durable steering",
			"steering answer",
			"fault input",
		]);
		expect(driver.session.messages.map(getMessageText)).toEqual([
			"initial input",
			"durable steering",
			"steering answer",
			"fault input",
			"recovered",
			"durable follow-up",
			"follow-up answer",
		]);
	});

	it("S7 eviction preserves queued steering without a latch and consumes it once on resume", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("steered answer")]);
		await driver.prompt("input");
		const old = driver.session;
		await driver.enqueue({ id: "steer-eviction", kind: "steering", text: "turn left" });
		expect(driver.inbox).toEqual([{ id: "steer-eviction", kind: "steering", text: "turn left" }]);
		await driver.evict();
		expect(driver.latchHistory).toEqual([]);
		await driver.resume();
		await driver.settle();
		await old.agent.continueWithQueuedMessages();
		expect(driver.counters.providerCalls).toBe(2);
		expect(driver.inbox).toEqual([{ id: "steer-eviction", kind: "steering", text: "turn left", consumedBy: 2 }]);
		expect(driver.consumeJournal).toEqual([{ messageId: "steer-eviction", generation: 2, rowIndex: 2 }]);
		expect(driver.callLog()[1]?.context.messages.map(getMessageText)).toEqual(["input", "first answer", "turn left"]);
		expect(driver.rows.map((row) => getMessageText(row.message))).toEqual([
			"input",
			"first answer",
			"turn left",
			"steered answer",
		]);
		expect(driver.counters.drainedBy).toEqual([2]);
	});

	it.each([false, true])(
		"[harness-gap] S13 pending tools preserve golden hooks/events with queued steering=%s",
		async (steering) => {
			const goldenTrace: string[] = [];
			const resumedTrace: string[] = [];
			const goldenGate = heldHandler();
			const goldenTool = recoveryTool(goldenGate.run);
			const resumedTool = recoveryTool();
			const control = await createHarness({
				tools: [goldenTool.tool],
				extensionFactories: recoveryHooks(goldenTrace),
			});
			fused.push(control);
			const driver = await createReferenceDriver({
				tools: [resumedTool.tool],
				extensionFactories: recoveryHooks(resumedTrace),
			});
			drivers.push(driver);
			const message = fauxAssistantMessage([fauxToolCall("record", {}, { id: "parity-1" })], {
				stopReason: "toolUse",
			});
			control.setResponses([message, fauxAssistantMessage("completed")]);
			driver.setResponses([message, fauxAssistantMessage("completed")]);
			const goldenPrompt = control.session.prompt("input");
			await goldenGate.entered;
			if (steering) await control.session.steer("turn left");
			goldenGate.release();
			await goldenPrompt;
			expect(goldenTrace).toEqual([
				"call:parity-1",
				"result:parity-1",
				"end:parity-1",
				...(steering ? ["steering"] : []),
			]);
			const hold = driver.inject.pauseNextTool();
			const prompt = driver.prompt("input");
			await hold.reached;
			if (steering) await driver.enqueue({ id: "parity-steer", kind: "steering", text: "turn left" });
			await driver.evict();
			await prompt;
			const discardedEnd = resumedTrace.length;
			await driver.resume();
			await driver.settle();
			expect(resumedTool.effects).toEqual(["parity-1"]);
			expect(driver.toolLedger.filter((entry) => entry.outcome === "ran")).toMatchObject([
				{ toolCallId: "parity-1", generation: 2 },
			]);
			expect(resumedTrace.slice(discardedEnd), "resume must execute the same public tool hooks and events").toEqual(
				goldenTrace,
			);
			expect(driver.callLog()[1]?.context.messages.map(getMessageText)).toEqual(
				control.faux.getCallLog()[1]?.context.messages.map(getMessageText),
			);
			expect(driver.consumeJournal.map((entry) => entry.messageId)).toEqual(steering ? ["parity-steer"] : []);
		},
	);

	it.each(["message_end", "agent_settled"] as const)(
		"S11 rebuilds within the deadline while the old %s handler stays pending",
		async (eventType) => {
			const handler = heldHandler();
			let held = false;
			const driver = await createReferenceDriver({
				extensionFactories: [
					(pi) => {
						const holdOnce = async () => {
							if (held) return;
							held = true;
							await handler.run();
						};
						if (eventType === "message_end") {
							pi.on("message_end", async (event) => {
								if (event.message.role === "assistant" && getMessageText(event.message) === "uncommitted")
									await holdOnce();
							});
						} else {
							pi.on("agent_settled", holdOnce);
						}
					},
				],
			});
			drivers.push(driver);
			driver.setResponses([fauxAssistantMessage("uncommitted"), fauxAssistantMessage("recovered")]);
			driver.inject.nextCommit("reject");
			driver.inject.slowRebuildStoreRead(HOSTED_REBUILD_DEADLINE_MS - 1);
			const old = driver.session;
			const rejected = Promise.withResolvers<void>();
			const unsubscribe = old.agent.subscribe((event) => {
				if (event.type === "message_start" && driver.latched) rejected.resolve();
			});
			let promptReturned = false;
			const prompt = old.prompt("input").then(() => {
				promptReturned = true;
			});
			try {
				await handler.entered;
				await rejected.promise;
				await driver.rebuildStoreReadStarted();
				expect(driver.latched).toBe(true);
				expect(driver.generation).toBe(2);
				const model = old.model;
				if (!model) throw new Error("The faux session has no model");
				await expect(
					old.agent.streamFunction(model, normalizeContext({ messages: [] }), { streamKind: "main" }),
				).rejects.toThrowError(/generation/);
				expect(driver.counters.auxRefusals).toBe(1);
				expect(driver.counters.providerCalls).toBe(1);
				driver.clock.advance(HOSTED_REBUILD_DEADLINE_MS - 1);
				await driver.whenRebuilt();
				await driver.settle();
				expect(driver.clock.now()).toBeLessThanOrEqual(HOSTED_REBUILD_DEADLINE_MS);
				expect(driver.counters.rebuildDeadlineMisses).toBe(0);
				expect(driver.rebuilds).toBe(1);
				expect(driver.session).not.toBe(old);
				expect(promptReturned, "new instance completes while old prompt remains pending").toBe(false);
				expect(driver.rows.map((row) => getMessageText(row.message))).toEqual(["input", "recovered"]);
				const before = driver.counters;
				handler.release();
				await prompt;
				await old.prompt("late old admission");
				expect(driver.counters.admissions).toBe(before.admissions);
				expect(driver.counters.providerCalls).toBe(before.providerCalls);
				expect(driver.counters.refusals).toBe(before.refusals + 2);
			} finally {
				handler.release();
				await prompt;
				unsubscribe();
			}
		},
	);

	it.each(["compaction", "branch"] as const)(
		"S15 %s summary after rebuild reads the same committed mirror context as fused",
		async (kind) => {
			const options = { settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 256 } } };
			const driver = await createReferenceDriver(options);
			drivers.push(driver);
			const control = await createHarness(options);
			fused.push(control);
			const responses = [
				fauxAssistantMessage("answer one", { timestamp: 1 }),
				fauxAssistantMessage("answer two", { timestamp: 2 }),
				fauxAssistantMessage("summary", { timestamp: 3 }),
				fauxAssistantMessage("turn prefix summary", { timestamp: 4 }),
			];
			driver.setResponses([
				responses[0],
				fauxAssistantMessage("uncommitted branch", { timestamp: 9 }),
				...responses.slice(1),
			]);
			control.setResponses([...responses]);
			for (const text of ["first question", "second question"]) {
				if (text === "second question") driver.inject.nextCommit("reject");
				await driver.prompt(text);
				await control.session.prompt(text);
			}
			expect(driver.rebuilds).toBe(1);
			if (kind === "compaction") {
				await driver.session.compact();
				await control.session.compact();
			} else {
				const hostedRoot = driver.session.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							getMessageText(entry.message) === "first question",
					);
				const fusedRoot = control.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							getMessageText(entry.message) === "first question",
					);
				if (!hostedRoot || !fusedRoot) throw new Error("Two completed turns must have a root entry");
				await driver.session.navigateTree(hostedRoot.id, { summarize: true });
				await control.session.navigateTree(fusedRoot.id, { summarize: true });
			}
			expect(driver.callLog()).toHaveLength(kind === "compaction" ? 5 : 4);
			expect(control.faux.getCallLog()).toHaveLength(kind === "compaction" ? 4 : 3);
			await driver.settleAux();
			expect(driver.counters.admissions).toBe(3);
			expect(driver.counters.auxRefusals).toBe(0);
			expect(driver.counters.auxAdmissions).toBe(kind === "compaction" ? 2 : 1);
			expect(driver.auxRows).toEqual(
				kind === "compaction"
					? [
							{ kind: "aux", generation: 2, auxKey: "aux-1" },
							{ kind: "aux", generation: 2, auxKey: "aux-2" },
						]
					: [{ kind: "aux", generation: 2, auxKey: "aux-1" }],
			);
			const hostedContexts = driver
				.callLog()
				.slice(3)
				.map((call) => call.context.messages.map(getMessageText));
			const fusedContexts = control.faux
				.getCallLog()
				.slice(2)
				.map((call) => call.context.messages.map(getMessageText));
			expect(hostedContexts).toEqual(fusedContexts);
			expect(hostedContexts.flat().join("\n")).toContain("answer one");
			expect(hostedContexts.flat().join("\n")).not.toContain("uncommitted branch");
		},
	);
});
