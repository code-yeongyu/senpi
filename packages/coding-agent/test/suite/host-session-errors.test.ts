import { describe, expect, it } from "vitest";
import { mapError } from "../../src/modes/rpc/host-session-errors.ts";
import { RpcCommandError, RpcTransportGoneError } from "../../src/modes/rpc/rpc-client.ts";

// #3073: host replies map to typed reasons and exit codes without scraping prose.
describe("host session error mapping", () => {
	it.each([
		["unknown_session", "unknown_session", 3],
		["future_code", "future_code", 3],
		["invalid_path", "invalid_path", 2],
		["open_failed", "open_failed", 1],
		["invalid_path", undefined, 2],
		["open_failed: unavailable", undefined, 1],
		["Model not found: a/b", undefined, 3],
		["Entry not found: x", undefined, 3],
		["Agent is already processing a prompt", undefined, 3],
	] as const)("maps host response %s", (message, code, exitCode) => {
		const reason =
			code ??
			(message.startsWith("Model")
				? "model_not_found"
				: message.startsWith("Entry")
					? "unknown_cursor"
					: message.startsWith("Agent")
						? "busy"
						: message.split(":")[0]);
		const data = { holders: [{ pid: 42 }] };
		expect(mapError(new RpcCommandError(message, code, data), "/rpc.sock")).toEqual({
			exitCode,
			payload: { action: exitCode === 3 ? "refuse" : "error", reason, detail: message, data, socket: "/rpc.sock" },
		});
	});

	it("classifies lost transport separately from host refusals", () => {
		expect(mapError(new RpcTransportGoneError(), "/rpc.sock")).toMatchObject({
			exitCode: 1,
			payload: { action: "error", reason: "transport_gone" },
		});
	});
});
