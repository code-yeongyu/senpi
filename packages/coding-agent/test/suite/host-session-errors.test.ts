import { describe, expect, it } from "vitest";
import { mapError } from "../../src/modes/rpc/host-session-errors.ts";
import { RpcCommandError, RpcTransportGoneError } from "../../src/modes/rpc/rpc-client.ts";

// #3073: host replies map to typed reasons and exit codes by their codes, never by message prose.
describe("host session error mapping", () => {
	it.each([
		// [host message, host errorCode, exit code, action, reason]
		["unknown_session", undefined, 3, "refuse", "unknown_session"],
		["session_path_in_use", "session_path_in_use", 3, "refuse", "session_path_in_use"],
		["future_code", "future_code", 3, "refuse", "future_code"],
		["invalid_path", undefined, 2, "error", "invalid_path"],
		["open_failed", undefined, 1, "error", "open_failed"],
		["Agent is already processing. Specify streamingBehavior", "streaming", 3, "refuse", "busy"],
		["Model not found: a/b", "model_not_found", 3, "refuse", "model_not_found"],
		["Entry not found: x", "not_found", 3, "refuse", "unknown_cursor"],
		["Agent is already processing a prompt", undefined, 1, "error", "host_error"],
		["Model not found: a/b", undefined, 1, "error", "host_error"],
		["open_failed: unavailable", undefined, 1, "error", "host_error"],
		["RPC prompt message exceeds 1000000 characters.", undefined, 1, "error", "host_error"],
	] as const)("maps %j (code %j) to exit %i %s/%s", (message, code, exitCode, action, reason) => {
		expect(mapError(new RpcCommandError(message, code, undefined), "/rpc.sock")).toEqual({
			exitCode,
			payload: { action, reason, detail: message, socket: "/rpc.sock" },
		});
	});

	it("passes the host's errorData through", () => {
		const data = { holders: [{ pid: 42 }] };
		expect(mapError(new RpcCommandError("session_held", "session_held", data), "/rpc.sock").payload).toEqual({
			action: "refuse",
			reason: "session_held",
			detail: "session_held",
			socket: "/rpc.sock",
			data,
		});
	});

	// senpi#4411: a prompt the session cannot start for lack of credentials is a typed refusal (exit 3), not a host error.
	it.each(["provider_credentials_missing", "provider_credentials_expired"] as const)(
		"refuses %s with the provider",
		(code) => {
			const message = "No API key found for openai.";
			expect(mapError(new RpcCommandError(message, code, { provider: "openai" }), "/rpc.sock")).toEqual({
				exitCode: 3,
				payload: {
					action: "refuse",
					reason: code,
					detail: message,
					socket: "/rpc.sock",
					data: { provider: "openai" },
				},
			});
		},
	);

	it("classifies lost transport separately from host refusals", () => {
		expect(mapError(new RpcTransportGoneError(), "/rpc.sock")).toMatchObject({
			exitCode: 1,
			payload: { action: "error", reason: "transport_gone" },
		});
	});
});
