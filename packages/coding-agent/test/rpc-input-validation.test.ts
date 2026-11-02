import { describe, expect, it } from "vitest";
import {
	MAX_RPC_MESSAGE_CHARACTERS,
	rpcCommandPayloadError,
	rpcCommandShapeError,
	rpcMessageLengthError,
} from "../src/modes/rpc/rpc-input-validation.ts";

function appendEntryCommand(entry: Record<string, unknown>) {
	return {
		type: "append_session_entry",
		entry: { id: "entry-1", parentId: null, timestamp: new Date().toISOString(), ...entry },
	};
}

describe("RPC input validation", () => {
	it.each([null, [], 42, "str", true])("rejects non-object command input: %j", (command) => {
		expect(rpcCommandShapeError(command)).toBe("RPC command must be a JSON object.");
	});

	it("accepts object-shaped command input", () => {
		expect(rpcCommandShapeError({ type: "get_commands" })).toBeUndefined();
	});

	it.each(["prompt", "steer", "follow_up"] as const)(
		"rejects oversized %s text without counting other fields",
		(type) => {
			const message = "x".repeat(MAX_RPC_MESSAGE_CHARACTERS + 1);

			expect(rpcMessageLengthError({ type, message })).toBe(
				`RPC ${type} message exceeds ${MAX_RPC_MESSAGE_CHARACTERS} characters.`,
			);
		},
	);

	// https://github.com/code-yeongyu/senpi/issues/1526
	it("accepts a refused model switch entry and rejects one without its detail", () => {
		const rejection = {
			type: "model_change_rejected",
			provider: "faux",
			modelId: "too-small",
			reason: "context-budget",
			detail: 'Model "faux/too-small" cannot switch: ...',
		};

		expect(rpcCommandPayloadError(appendEntryCommand(rejection))).toBeUndefined();
		expect(rpcCommandPayloadError(appendEntryCommand({ ...rejection, detail: undefined }))).toBe(
			"append_session_entry entry is malformed.",
		);
	});

	it("accepts the maximum text length and ignores non-message commands", () => {
		expect(
			rpcMessageLengthError({ type: "prompt", message: "x".repeat(MAX_RPC_MESSAGE_CHARACTERS) }),
		).toBeUndefined();
		expect(rpcMessageLengthError({ type: "get_commands" })).toBeUndefined();
	});
});
