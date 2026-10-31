import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachToOpenSession } from "../../src/modes/rpc/session-registry-attach.ts";
import { type RpcSessionEntry, RpcSessionRegistryError } from "../../src/modes/rpc/session-registry-types.ts";

const WAIT_ENV = "SENPI_OPEN_IN_PROGRESS_WAIT_MS";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env[WAIT_ENV];
});

function openingEntry(openCompletion: Promise<void>): RpcSessionEntry {
	return {
		state: "opening",
		reservationKey: "/tmp/session.jsonl",
		sessionPath: "/tmp/session.jsonl",
		openCompletion,
	} as unknown as RpcSessionEntry;
}

function openArgs(entries: ReadonlyMap<string, RpcSessionEntry>) {
	return [entries, "/tmp/session.jsonl", { cwd: "/tmp" } as never, undefined, undefined, 0] as const;
}

async function failureOf(promise: Promise<unknown>): Promise<RpcSessionRegistryError> {
	try {
		await promise;
		throw new Error("expected the open to be refused");
	} catch (cause) {
		expect(cause).toBeInstanceOf(RpcSessionRegistryError);
		return cause as RpcSessionRegistryError;
	}
}

describe("attachToOpenSession waiter bound", () => {
	it("times out a never-settling in-flight open with a retryable open_in_progress, naming an attached owner and leaving the entry alone", async () => {
		process.env[WAIT_ENV] = "100";
		const openCompletion = new Promise<void>(() => {});
		const entry = openingEntry(openCompletion);
		const entries = new Map<string, RpcSessionEntry>([["rpc-1", entry]]);

		const refused = failureOf(attachToOpenSession(...openArgs(entries)));
		await vi.advanceTimersByTimeAsync(100);
		const cause = await refused;

		expect(cause.code).toBe("session_path_in_use");
		expect(cause.detail).toMatchObject({ reason: "open_in_progress" });
		expect((cause.detail as { retry_after_ms?: number }).retry_after_ms).toBeGreaterThan(0);
		expect(cause.detail).toMatchObject({ owner: { attached: true, current: true } });
		expect(entry.state).toBe("opening");
		expect(entries.get("rpc-1")).toBe(entry);
	});

	it("gives a waiter on a FAILED in-flight open session_path_in_use again, not the opener's own open_failed", async () => {
		const openCompletion = Promise.reject(new RpcSessionRegistryError("open_failed", "boom"));
		const entry = openingEntry(openCompletion);
		const entries = new Map<string, RpcSessionEntry>([["rpc-1", entry]]);

		const cause = await failureOf(attachToOpenSession(...openArgs(entries)));

		expect(cause.code).toBe("session_path_in_use");
		expect(cause.code).not.toBe("open_failed");
		expect(cause.detail).toMatchObject({ reason: "open_failed" });
	});
});
