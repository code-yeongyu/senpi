import { describe, expect, it, vi } from "vitest";
import {
	loadSocketSecretPresence,
	type NativePresenceBinding,
	type NativePresenceResult,
} from "../../../src/modes/rpc/socket-secret-native.ts";

const probe = {
	presenceId: "owner",
	path: "C:\\private\\owner.lock",
	tag: Buffer.from("opaque-tag"),
	volumeSerial: "7",
	fileId: "9",
	createdLocal: true,
	relocated: false,
	kernelSession: null,
};

function native(result: NativePresenceResult): NativePresenceBinding {
	return {
		presenceAcquire: vi.fn(() => result),
		presenceProbe: vi.fn(() => result),
		presenceProbeRetained: vi.fn(() => result),
		presencePreActionCheck: vi.fn(() => result),
		presenceWaitAndAcquire: vi.fn(async () => result),
		presenceCancelWait: vi.fn(),
		presenceReleaseAfterQuiescence: vi.fn(() => result),
	};
}

describe("#4199 Windows presence bridge", () => {
	it.each(["linux", "darwin"])("reports unavailable on %s without loading a native module", (platform) => {
		const requireBinding = vi.fn();
		expect(loadSocketSecretPresence({ platform, requireBinding })).toEqual({
			status: "unavailable",
			reason: "unsupported_platform",
		});
		expect(requireBinding).not.toHaveBeenCalled();
	});

	it.each([
		{ status: "acquired" },
		{ status: "occupied" },
		{ status: "unknown", reason: "identity_changed" },
		{ status: "unknown", code: 5, reason: "os_error" },
		{ status: "fenced", reason: "not_local" },
		{ status: "unavailable", reason: "unsupported_platform" },
	] as const)("preserves the typed probe verdict $status", (result) => {
		const binding = native(result);
		const loaded = loadSocketSecretPresence({ platform: "win32" }, binding);
		expect(loaded.status).toBe("available");
		if (loaded.status !== "available") throw new Error("expected Windows binding");
		expect(loaded.guard.probe(probe)).toEqual(result);
		expect(binding.presenceProbe).toHaveBeenCalledWith(probe);
	});

	it("forwards authority checks and releases only with the quiescence receipt", () => {
		const binding = native({ status: "acquired" });
		const loaded = loadSocketSecretPresence({ platform: "win32" }, binding);
		if (loaded.status !== "available") throw new Error("expected Windows binding");
		expect(loaded.guard.acquire("owner", probe.path)).toEqual({ status: "acquired" });
		loaded.guard.preActionCheck("owner");
		loaded.guard.releaseAfterQuiescence({ presenceId: "owner", state: "released" });
		expect(binding.presenceAcquire).toHaveBeenCalledWith("owner", probe.path);
		expect(binding.presencePreActionCheck).toHaveBeenCalledWith("owner");
		expect(binding.presenceReleaseAfterQuiescence).toHaveBeenCalledWith({ presenceId: "owner", state: "released" });
	});

	it("maps cancellation of an outstanding native wait without polling", async () => {
		let finish!: (result: NativePresenceResult) => void;
		const binding = native({ status: "acquired" });
		const wait = vi.fn(
			(_presenceId: string, _path: string, _waitId: string) =>
				new Promise<NativePresenceResult>((resolve) => {
					finish = resolve;
				}),
		);
		binding.presenceWaitAndAcquire = wait;
		binding.presenceCancelWait = vi.fn(() => finish({ status: "cancelled" }));
		const loaded = loadSocketSecretPresence({ platform: "win32" }, binding);
		if (loaded.status !== "available") throw new Error("expected Windows binding");
		const abort = new AbortController();
		const waiting = loaded.guard.waitAndAcquire("owner", probe.path, abort.signal);
		abort.abort();
		await expect(waiting).resolves.toEqual({ status: "cancelled" });
		expect(binding.presenceCancelWait).toHaveBeenCalledWith(wait.mock.calls[0]?.[2]);
	});

	it("does not cancel another operation waiting on the same presence ID", async () => {
		const binding = native({ status: "acquired" });
		let finish!: (result: NativePresenceResult) => void;
		let firstWaitId = "";
		binding.presenceWaitAndAcquire = vi.fn((_id: string, _path: string, waitId: string) => {
			if (firstWaitId) return Promise.resolve({ status: "unknown", reason: "wait_pending" } as const);
			firstWaitId = waitId;
			return new Promise<NativePresenceResult>((resolve) => {
				finish = resolve;
			});
		});
		binding.presenceCancelWait = vi.fn((waitId: string) => {
			if (waitId === firstWaitId) finish({ status: "cancelled" });
		});
		const loaded = loadSocketSecretPresence({ platform: "win32" }, binding);
		if (loaded.status !== "available") throw new Error("expected Windows binding");
		const firstAbort = new AbortController();
		const secondAbort = new AbortController();
		const first = loaded.guard.waitAndAcquire("owner", probe.path, firstAbort.signal);
		const second = loaded.guard.waitAndAcquire("owner", probe.path, secondAbort.signal);
		secondAbort.abort();
		expect(binding.presenceCancelWait).not.toHaveBeenCalledWith(firstWaitId);
		await expect(second).resolves.toEqual({ status: "unknown", reason: "wait_pending" });
		firstAbort.abort();
		await expect(first).resolves.toEqual({ status: "cancelled" });
	});

	it("does not start a wait for an already cancelled operation", async () => {
		const binding = native({ status: "acquired" });
		const loaded = loadSocketSecretPresence({ platform: "win32" }, binding);
		if (loaded.status !== "available") throw new Error("expected Windows binding");
		const abort = new AbortController();
		abort.abort();
		await expect(loaded.guard.waitAndAcquire("owner", probe.path, abort.signal)).resolves.toEqual({
			status: "cancelled",
		});
		expect(binding.presenceWaitAndAcquire).not.toHaveBeenCalled();
	});
});
