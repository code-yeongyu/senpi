import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../src/modes/app-server/daemon/process.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/app-server/daemon/process.ts")>();
	return {
		...actual,
		readProcessIdentity: () => {
			probe.calls += 1;
			return Promise.resolve({ kind: "present" as const, identity: "test-identity" });
		},
	};
});

import { armHostWatchdog } from "../../../src/modes/rpc/host-watchdog.ts";

describe("host watchdog ppid fallback", () => {
	afterEach(() => {
		vi.useRealTimers();
		probe.calls = 0;
	});

	it("performs zero process-identity probes while the supervisor is alive", async () => {
		vi.useFakeTimers();
		const disarm = armHostWatchdog({ ppid: process.ppid }, () => {});
		try {
			await vi.advanceTimersByTimeAsync(5_000);
			expect(probe.calls).toBe(0);
		} finally {
			disarm();
		}
	});

	it("still fires when the supervisor pid is gone", async () => {
		vi.useFakeTimers();
		let fired = "";
		const disarm = armHostWatchdog({ ppid: 999_999 }, (reason) => {
			fired = reason;
		});
		try {
			await vi.advanceTimersByTimeAsync(300);
			expect(fired).toContain("999999");
		} finally {
			disarm();
		}
	});
});
