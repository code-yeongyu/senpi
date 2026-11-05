import { describe, expect, it, vi } from "vitest";
import {
	type NativePublishResult,
	publishSocketSecretNoReplace,
	SocketSecretPublishError,
} from "../src/modes/rpc/socket-secret-native.ts";

const staging = "C:\\Users\\u\\AppData\\Local\\senpi\\rpc.sock.secret.stage-a";
const finalPath = "C:\\Users\\u\\AppData\\Local\\senpi\\rpc.sock.secret";
const secret = Buffer.from("SENTINEL-socket-secret-0123456789");
const leftover = { path: staging, windowsError: 5 };
const bridge = (result: NativePublishResult) => ({ publishNoReplace: vi.fn(() => result) });

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a throw");
}

// Review r1 LOW 3 (lead ruling): a staging file that a failed delete disposition left behind reaches the caller
// as a typed result naming the path to remove, never as a log line, and never with the secret bytes.
describe("publishSocketSecretNoReplace", () => {
	it("carries a staging file left behind by a failed delete disposition on a collision", () => {
		const binding = bridge({ outcome: "collision", stagingLeftBehind: leftover });
		const result = publishSocketSecretNoReplace(binding, staging, finalPath, secret);
		expect(binding.publishNoReplace).toHaveBeenCalledWith(staging, finalPath, secret);
		expect(result).toEqual({
			outcome: "collision",
			stagingLeftBehind: {
				path: staging,
				windowsError: 5,
				action: `Delete the leftover socket-secret staging file ${staging}`,
			},
		});
		expect(JSON.stringify(result)).not.toContain(secret.toString());
	});

	it("throws a typed failure that still carries the leftover staging file", () => {
		const binding = bridge({ outcome: "failed", failure: { step: "rename", code: 32 }, stagingLeftBehind: leftover });
		const failure = thrown(() => publishSocketSecretNoReplace(binding, staging, finalPath, secret));
		expect(failure).toBeInstanceOf(SocketSecretPublishError);
		expect(failure).toMatchObject({
			code: "socket-secret-publish-failed",
			step: "rename",
			windowsError: 32,
			stagingLeftBehind: { path: staging, windowsError: 5 },
		});
		expect(String((failure as Error).message)).not.toContain(secret.toString());
	});

	it("reports no leftover after a clean publication", () => {
		const result = publishSocketSecretNoReplace(bridge({ outcome: "published" }), staging, finalPath, secret);
		expect(result).toEqual({ outcome: "published", stagingLeftBehind: null });
	});

	it("fails closed on an outcome the bridge does not define", () => {
		const binding = bridge({ outcome: "replaced" } as unknown as NativePublishResult);
		expect(() => publishSocketSecretNoReplace(binding, staging, finalPath, secret)).toThrow(SocketSecretPublishError);
	});
});
