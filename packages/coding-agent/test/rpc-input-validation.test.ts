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

	// senpi#6443
	it.each([
		[
			"dryRun that is a string",
			{ type: "unload_session", sessionId: "s", dryRun: "yes" },
			"dryRun must be a boolean.",
		],
		["dryRun that is a number", { type: "unload_session", sessionId: "s", dryRun: 1 }, "dryRun must be a boolean."],
		[
			"an empty client_id",
			{ type: "set_client_info", client_id: "" },
			"client_id must be a string of 1 to 256 characters.",
		],
		[
			"a client_id of 257 characters",
			{ type: "set_client_info", client_id: "c".repeat(257) },
			"client_id must be a string of 1 to 256 characters.",
		],
		[
			"a client_id that is a number",
			{ type: "set_client_info", client_id: 7 },
			"client_id must be a string of 1 to 256 characters.",
		],
	])("rejects %s", (_case, command, message) => {
		expect(rpcCommandPayloadError(command)).toBe(message);
	});

	it.each([
		["a dry run flag", { type: "unload_session", sessionId: "s", dryRun: true }],
		["a client_id of one character", { type: "set_client_info", client_id: "c" }],
		["a client_id of 256 characters", { type: "set_client_info", client_id: "c".repeat(256) }],
		["a declaration with no client_id", { type: "set_client_info", width: 80 }],
	])("accepts %s", (_case, command) => {
		expect(rpcCommandPayloadError(command)).toBeUndefined();
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
