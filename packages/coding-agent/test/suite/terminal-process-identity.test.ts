import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BOOT_INSTANT_TOLERANCE_MS,
	ownProcessStartedAtMs,
	processBootAtMs,
	sameBoot,
} from "../../src/core/extensions/builtin/terminal/process-identity.ts";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof os>();
	return { ...actual, uptime: vi.fn(actual.uptime) };
});

afterEach(() => {
	vi.mocked(os.uptime).mockReset();
	vi.restoreAllMocks();
});

describe("terminal process identity", () => {
	it("derives a whole-second boot instant from os.uptime that two consecutive reads agree on", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_600);
		vi.mocked(os.uptime).mockReturnValue(86_400);
		const boot = processBootAtMs();
		expect(boot).toBe(1_789_913_601_000);
		expect(Number.isInteger(boot)).toBe(true);
		expect(boot % 1000).toBe(0);
		expect(boot).toBeLessThan(Date.now());
		expect(processBootAtMs()).toBe(boot);
	});

	it.runIf(process.platform === "darwin")("matches the kernel boot time on darwin within the tolerance", () => {
		const raw = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
		const seconds = Number(/sec = (\d+)/.exec(raw)?.[1]);
		expect(Number.isFinite(seconds)).toBe(true);
		expect(Math.abs(processBootAtMs() - seconds * 1000)).toBeLessThanOrEqual(BOOT_INSTANT_TOLERANCE_MS);
	});

	it("reports the own process start within a few seconds of now for a fresh process", () => {
		const started = ownProcessStartedAtMs();
		expect(started % 1000).toBe(0);
		expect(started).toBeLessThanOrEqual(Date.now());
		expect(Date.now() - started).toBeLessThan(15 * 60_000);
	});

	it("floors the own start to the second like ps does, so it never lands after now", () => {
		vi.spyOn(process, "uptime").mockReturnValue(10);
		const uptimeMs = process.uptime() * 1000;
		const now = 1_790_000_000_600 + uptimeMs;
		expect(ownProcessStartedAtMs(() => now)).toBe(1_790_000_000_000);
	});

	it("treats two boot instants as the same boot only inside the tolerance", () => {
		const boot = 1_700_000_000_000;
		expect(sameBoot(boot, boot + BOOT_INSTANT_TOLERANCE_MS)).toBe(true);
		expect(sameBoot(boot, boot - BOOT_INSTANT_TOLERANCE_MS)).toBe(true);
		expect(sameBoot(boot, boot + BOOT_INSTANT_TOLERANCE_MS + 1)).toBe(false);
		expect(sameBoot(boot, undefined)).toBe(false);
	});
});
