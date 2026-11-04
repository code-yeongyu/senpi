import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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
		const fixture = await createIdentityHarness({
			extensionFactories: [
				(pi) => {
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
		fixture.harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = async (model, context, options) => {
			entered.resolve();
			await release.promise;
			return stream(model, context, options);
		};
		const rpc = fixture.bind();
		const runningTurnId = async (): Promise<unknown> =>
			((await rpc.send({ type: "get_state" })).data as { currentTurnId?: unknown }).currentTurnId;
		const startHeldTurn = async (): Promise<unknown> => {
			await rpc.send({ type: "prompt", message: "hold" });
			await entered.promise;
			return runningTurnId();
		};
		return {
			fixture,
			rpc,
			runningTurnId,
			startHeldTurn,
			releaseTurn: () => release.resolve(),
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
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
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
