import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getAssistantTexts } from "./harness.ts";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

// omo-desktop-app#1325: a lost transport acknowledgment must not produce another answer.
describe("durable RPC client message admission", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});
	const setup = async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		return fixture;
	};

	it("answers once when the same completed prompt is delivered with a new transport id", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		const command = {
			type: "prompt",
			message: "hello",
			clientMessageId: "message-1",
			clientTurnId: "turn-1",
		};
		const original = await rpc.send(command);
		await Promise.all(rpc.handler.pendingPrompts());

		// When
		const repeated = await rpc.send(command);
		await Promise.all(rpc.handler.pendingPrompts());

		// Then
		expect(getAssistantTexts(fixture.harness)).toEqual(["first answer"]);
		expect(repeated).toMatchObject({
			success: true,
			data: { admission: { state: "completed", clientMessageId: "message-1", clientTurnId: "turn-1" } },
		});
		const protocol = await rpc.send({ type: "get_protocol_info" });
		expect(protocol).toMatchObject({
			data: { capabilities: expect.arrayContaining(["durable_client_message_id"]) },
		});
		expect(rpc.messages().filter((event) => event.type === "turn_start")).toEqual([
			expect.objectContaining({ clientMessageId: "message-1", clientTurnId: "turn-1" }),
		]);
		const userStart = rpc.messages().findIndex((event) => event.type === "message_start");
		expect(rpc.messages().indexOf(original)).toBeLessThan(userStart);
		expect(fixture.session.messages.find((message) => message.role === "user")).toMatchObject({
			clientMessageId: "message-1",
			clientTurnId: "turn-1",
		});
	});

	it("rejects a conflicting payload without appending another user message", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		await rpc.send({ type: "prompt", message: "original", clientMessageId: "same" });
		await Promise.all(rpc.handler.pendingPrompts());

		// When
		const conflict = await rpc.send({ type: "prompt", message: "different", clientMessageId: "same" });
		await Promise.all(rpc.handler.pendingPrompts());

		// Then
		expect(conflict).toMatchObject({ success: false, errorCode: "client_message_id_conflict" });
		expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("does not execute a completed delivery again after reopening its transcript", async () => {
		// Given
		const fixture = await setup();
		const first = fixture.bind();
		const command = { type: "prompt", message: "remember", clientMessageId: "persistent" };
		await first.send(command);
		await Promise.all(first.handler.pendingPrompts());
		const reopened = await fixture.reopen();

		// When
		const response = await reopened.send(command);
		await Promise.all(reopened.handler.pendingPrompts());

		// Then
		expect(response).toMatchObject({ success: true, data: { admission: { state: "completed" } } });
		expect(
			fixture.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(1);
	});

	it.each(["steer", "follow_up"])("retains one queue record when %s is redelivered", async (type) => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		const command = { type, message: "queued", clientMessageId: "queue-1", clientTurnId: "queue-turn" };
		await rpc.send(command);

		// When
		const repeated = await rpc.send(command);
		const state = await rpc.send({ type: "get_state" });

		// Then
		expect(fixture.session.pendingMessageCount).toBe(1);
		expect(repeated).toMatchObject({ success: true, data: { admission: { state: "queued" } } });
		expect(state).toMatchObject({
			data: { ordered: [expect.objectContaining({ clientMessageId: "queue-1", clientTurnId: "queue-turn" })] },
		});
	});

	it("preserves independent admission when identical text has different client ids", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		await rpc.send({ type: "prompt", message: "same text", clientMessageId: "first" });
		await Promise.all(rpc.handler.pendingPrompts());

		// When
		await rpc.send({ type: "prompt", message: "same text", clientMessageId: "second" });
		await Promise.all(rpc.handler.pendingPrompts());

		// Then
		expect(getAssistantTexts(fixture.harness)).toEqual(["first answer", "second answer"]);
	});

	it.each([
		{ type: "steer" },
		{ type: "follow_up" },
		{ type: "prompt", streamingBehavior: "steer" },
		{ type: "prompt", streamingBehavior: "followUp" },
	])("answers queued input once with correlated events through %j", async (queueCommand) => {
		// Given
		const fixture = await setup();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = async (model, context, options) => {
			entered.resolve();
			await release.promise;
			return stream(model, context, options);
		};
		const rpc = fixture.bind();
		// Every exit path releases the held provider call, or cleanup would wait on a parked turn.
		try {
			await rpc.send({ type: "prompt", message: "hold", clientMessageId: "initial", clientTurnId: "initial-turn" });
			await entered.promise;
			const queued = { ...queueCommand, message: "after", clientMessageId: "queued", clientTurnId: "queued-turn" };
			await rpc.send(queued);

			// When
			await rpc.send(queued);
		} finally {
			release.resolve();
		}
		await Promise.all(rpc.handler.pendingPrompts());

		// Then
		expect(getAssistantTexts(fixture.harness)).toEqual(["first answer", "second answer"]);
		expect(rpc.messages().filter((event) => event.type === "turn_start")).toMatchObject([
			{ clientMessageId: "initial", clientTurnId: "initial-turn" },
			{ clientMessageId: "queued", clientTurnId: "queued-turn" },
		]);
		expect(fixture.session.pendingMessageCount).toBe(0);
	});

	it("does not attribute a custom-message trigger turn to the previous client message", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		await rpc.send({ type: "prompt", message: "hello", clientMessageId: "message-1", clientTurnId: "turn-1" });
		await Promise.all(rpc.handler.pendingPrompts());

		// When
		const wake = {
			type: "send_custom_message",
			customType: "wake",
			content: "wake",
			display: true,
			triggerTurn: true,
		};
		await rpc.send(wake);
		await fixture.session.waitForIdle();

		// Then
		expect(getAssistantTexts(fixture.harness)).toEqual(["first answer", "second answer"]);
		const turns = rpc.messages().filter((event) => event.type === "turn_start");
		expect(turns).toHaveLength(2);
		expect(turns[0]).toMatchObject({ clientMessageId: "message-1", clientTurnId: "turn-1" });
		expect(turns[1]).not.toHaveProperty("clientMessageId");
		const answers = rpc
			.messages()
			.filter(
				(event) =>
					event.type === "message_end" &&
					typeof event.message === "object" &&
					event.message !== null &&
					"role" in event.message &&
					event.message.role === "assistant",
			);
		expect(answers[0]).toMatchObject({ clientMessageId: "message-1" });
		expect(answers[1]).not.toHaveProperty("clientMessageId");
	});
});
