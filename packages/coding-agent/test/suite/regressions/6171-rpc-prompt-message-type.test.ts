import { afterEach, describe, expect, it } from "vitest";
import { rpcCommandPayloadError } from "../../../src/modes/rpc/rpc-input-validation.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#6171: an input command whose `message` is missing or not a string passed validation and the engine threw a
// raw TypeError (`text.startsWith`) instead of the client getting the boundary's refusal.
describe("RPC input commands with a missing or non-string message", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	it.each([
		{ name: "missing", command: { type: "prompt" } },
		{ name: "number", command: { type: "prompt", message: 42 } },
		{ name: "missing steer", command: { type: "steer" } },
		{ name: "number follow_up", command: { type: "follow_up", message: 7 } },
	])("refuses a $name message on the RPC path before admission", async ({ command }) => {
		const handlerSaw: string[] = [];
		const fixture = await createIdentityHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						handlerSaw.push(event.text);
						return { action: "continue" };
					});
				},
			],
		});
		fixtures.push(fixture);
		const rpc = fixture.bind();

		const response = await rpc.send(command);

		expect(response).toMatchObject({
			type: "response",
			command: command.type,
			success: false,
			error: "message must be a string.",
		});
		expect(handlerSaw).toEqual([]);
		expect(fixture.session.messages).toEqual([]);
		expect(fixture.session.pendingMessageCount).toBe(0);
	});

	it.each([
		{ type: "prompt", message: null },
		{ type: "steer", message: { text: "x" } },
		{ type: "follow_up", message: ["x"] },
	])("the validator refuses %j", (command) => {
		expect(rpcCommandPayloadError(command)).toBe("message must be a string.");
	});

	it.each([
		{ type: "prompt", message: "" },
		{ type: "steer", message: "x" },
		{ type: "follow_up", message: "x" },
	])("the validator accepts a string message: %j", (command) => {
		expect(rpcCommandPayloadError(command)).toBeUndefined();
	});

	it("keeps an earlier refusal's text when the message is also missing", () => {
		expect(rpcCommandPayloadError({ type: "steer", whenIdle: "later" })).toBe(
			'whenIdle must be "queue" or "start"; omit it to queue on an idle session.',
		);
	});
});
