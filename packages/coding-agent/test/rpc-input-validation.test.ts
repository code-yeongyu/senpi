import { describe, expect, it } from "vitest";
import {
	MAX_RPC_MESSAGE_CHARACTERS,
	rpcCommandShapeError,
	rpcMessageLengthError,
} from "../src/modes/rpc/rpc-input-validation.ts";

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

	it("accepts the maximum text length and ignores non-message commands", () => {
		expect(
			rpcMessageLengthError({ type: "prompt", message: "x".repeat(MAX_RPC_MESSAGE_CHARACTERS) }),
		).toBeUndefined();
		expect(rpcMessageLengthError({ type: "get_commands" })).toBeUndefined();
	});
});
