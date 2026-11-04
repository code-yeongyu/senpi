import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { rpcCommandPayloadError } from "../../../src/modes/rpc/rpc-input-validation.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#5776: every input command that targets the running turn (prompt steer/followUp, steer, follow_up) honours
// expectedTurnId; before this, steer and follow_up accepted the field silently and queued with no check.
describe("RPC input commands that name their turn", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	const setup = async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = async (model, context, options) => {
			entered.resolve();
			const aborted = new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
			await Promise.race([release.promise, aborted]);
			return stream(model, context, options);
		};
		const rpc = fixture.bind();
		await rpc.send({ type: "prompt", message: "hold" });
		await entered.promise;
		const turnId = ((await rpc.send({ type: "get_state" })).data as { currentTurnId?: unknown }).currentTurnId;
		return { fixture, rpc, turnId, release: () => release.resolve() };
	};

	const commands = [
		{ name: "steer", build: (expectedTurnId: unknown) => ({ type: "steer", message: "Late", expectedTurnId }) },
		{
			name: "follow_up",
			build: (expectedTurnId: unknown) => ({ type: "follow_up", message: "Late", expectedTurnId }),
		},
		{
			name: "prompt followUp",
			build: (expectedTurnId: unknown) => ({
				type: "prompt",
				message: "Late",
				streamingBehavior: "followUp",
				expectedTurnId,
			}),
		},
	];

	it.each(commands)("refuses a $name that names another turn and queues nothing", async ({ build }) => {
		const { fixture, rpc, turnId, release } = await setup();
		try {
			expect(typeof turnId).toBe("string");
			expect(await rpc.send(build("999"))).toMatchObject({
				success: false,
				errorCode: "turn_conflict",
				errorData: { currentTurnId: turnId },
			});
			expect(fixture.session.pendingMessageCount).toBe(0);
		} finally {
			release();
		}
		await Promise.all(rpc.handler.pendingPrompts());
	});

	it.each(commands)("queues a $name that names the running turn", async ({ build }) => {
		const { fixture, rpc, turnId, release } = await setup();
		try {
			expect(await rpc.send(build(turnId))).toMatchObject({ success: true });
			expect(fixture.session.pendingMessageCount).toBe(1);
		} finally {
			release();
		}
		await Promise.all(rpc.handler.pendingPrompts());
	});

	it.each([
		{ type: "steer", message: "x", expectedTurnId: "" },
		{ type: "follow_up", message: "x", expectedTurnId: 7 },
		{ type: "steer", message: "x", expectedTurnId: "t".repeat(257) },
		{ type: "prompt", message: "x", expectedTurnId: "1" },
	])("rejects a malformed or unplaced expectedTurnId: %j", (command) => {
		expect(rpcCommandPayloadError(command)).toMatch(/expectedTurnId/);
	});
});
