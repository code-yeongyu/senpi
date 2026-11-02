import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SessionRegistry,
	type SessionRegistrySession,
	type TerminalSessionSignal,
	type TrackedDetachedChild,
} from "../src/registry.ts";
import { cleanupDetachedChildren } from "../src/registry-detached.ts";

class IgnoresTermSession implements SessionRegistrySession {
	readonly command = "bash";
	readonly signals: TerminalSessionSignal[] = [];
	private exitedFlag = false;
	private resolveExit: (() => void) | null = null;
	private readonly exitPromise = new Promise<void>((resolve) => {
		this.resolveExit = resolve;
	});

	get isExited(): boolean {
		return this.exitedFlag;
	}

	kill(signal: TerminalSessionSignal = "SIGTERM"): void {
		this.signals.push(signal);
		if (signal !== "SIGKILL") return;
		this.exitedFlag = true;
		this.resolveExit?.();
	}

	waitExit(): Promise<unknown> {
		return this.exitPromise;
	}
}

describe("SessionRegistry stop escalation", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("escalates to SIGKILL and ends exited when the session ignores SIGTERM", async () => {
		vi.useFakeTimers();
		const registry = new SessionRegistry<IgnoresTermSession>({
			stopExitGraceMs: 1000,
			forcedExitGraceMs: 250,
		});
		const session = new IgnoresTermSession();
		const entry = await registry.create({ session });

		const stopped = registry.stop(entry.id);
		await vi.advanceTimersByTimeAsync(1000);

		await expect(stopped).resolves.toBe(true);
		expect(session.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(registry.get(entry.id)?.state).toBe("exited");
		expect(registry.get(entry.id)?.exitedAt).not.toBeNull();
	});

	it("escalates a live entry during teardown before dropping it", async () => {
		vi.useFakeTimers();
		const registry = new SessionRegistry<IgnoresTermSession>({
			stopExitGraceMs: 1000,
			forcedExitGraceMs: 250,
		});
		const session = new IgnoresTermSession();
		await registry.create({ session });

		const torndown = registry.teardown();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(torndown).resolves.toBeUndefined();
		expect(session.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(registry.size).toBe(0);
	});
});

describe("cleanupDetachedChildren escalation", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("SIGKILLs process groups still alive after the grace and spares the ones that exited", async () => {
		vi.useFakeTimers();
		let quitterExited = false;
		const children: readonly TrackedDetachedChild[] = [
			{ pid: 401, processGroupId: 401, exited: () => false },
			{ pid: 402, processGroupId: 402, exited: () => quitterExited },
		];
		const killed: string[] = [];
		const session: SessionRegistrySession = { getTrackedDetachedChildren: () => children };

		const cleanup = cleanupDetachedChildren(
			session,
			"linux",
			(target, signal) => {
				killed.push(`${target}:${signal}`);
				// 402 honors SIGTERM during the grace; 401 ignores it.
				if (target === -402 && signal === "SIGTERM") quitterExited = true;
			},
			1000,
		);
		await vi.advanceTimersByTimeAsync(1000);
		await cleanup;

		expect(killed).toEqual(["-401:SIGTERM", "-402:SIGTERM", "-401:SIGKILL"]);
	});

	it("escalates through the child kill callback when it survives the grace", async () => {
		vi.useFakeTimers();
		const signals: (TerminalSessionSignal | undefined)[] = [];
		const children: readonly TrackedDetachedChild[] = [
			{
				exited: () => false,
				kill: (signal) => {
					signals.push(signal);
				},
			},
		];
		const session: SessionRegistrySession = { getTrackedDetachedChildren: () => children };

		const cleanup = cleanupDetachedChildren(session, "linux", () => {}, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		await cleanup;

		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
