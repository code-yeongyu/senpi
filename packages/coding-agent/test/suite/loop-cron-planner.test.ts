import { describe, expect, it } from "vitest";
import {
	computeNextFireAt,
	describeCron,
	type EffectiveInterval,
	normalizeInterval,
	type RequestedInterval,
} from "../../src/core/extensions/builtin/loop/cron-planner.ts";

function req(value: number, unit: "s" | "m" | "h" | "d", raw: string): RequestedInterval {
	return { value, unit, raw };
}

function eff(
	value: number,
	unit: "m" | "h" | "d",
	human: string,
	rounded: boolean,
	roundingNotice: string | undefined,
): EffectiveInterval & { intervalMs: number } {
	const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
	return { value, unit, human, rounded, roundingNotice, intervalMs: value * unitMs };
}

describe("normalizeInterval", () => {
	it("5m -> 5 minutes, not rounded", () => {
		const result = normalizeInterval(req(5, "m", "5m"));
		expect(result).toEqual(eff(5, "m", "5 minutes", false, undefined));
		expect(describeCron(result)).toBe("*/5 * * * *");
	});

	it("45s -> 1 minute rounded with notice naming both cadences", () => {
		const result = normalizeInterval(req(45, "s", "45s"));
		expect(result).toEqual(eff(1, "m", "1 minute", true, "Requested 45s rounds to 1 minute."));
		expect(describeCron(result)).toBe("*/1 * * * *");
	});

	it("90m -> 2 hours rounded with notice naming both cadences", () => {
		const result = normalizeInterval(req(90, "m", "90m"));
		expect(result).toEqual(eff(2, "h", "2 hours", true, "Requested 90m rounds to 2 hours."));
		expect(describeCron(result)).toBe("0 */2 * * *");
	});

	it("7m -> 7 minutes with */7 cron and no rounding claim", () => {
		const result = normalizeInterval(req(7, "m", "7m"));
		expect(result).toEqual(eff(7, "m", "7 minutes", false, undefined));
		expect(describeCron(result)).toBe("*/7 * * * *");
	});

	it("1h -> 0 */1 * * * consistently", () => {
		const result = normalizeInterval(req(1, "h", "1h"));
		expect(result).toEqual(eff(1, "h", "1 hour", false, undefined));
		expect(describeCron(result)).toBe("0 */1 * * *");
	});

	it("36h -> 2 days rounded with notice naming both cadences", () => {
		const result = normalizeInterval(req(36, "h", "36h"));
		expect(result).toEqual(eff(2, "d", "2 days", true, "Requested 36h rounds to 2 days."));
		expect(describeCron(result)).toBe("0 0 */2 * *");
	});

	it("1d -> 0 0 */1 * *", () => {
		const result = normalizeInterval(req(1, "d", "1d"));
		expect(result).toEqual(eff(1, "d", "1 day", false, undefined));
		expect(describeCron(result)).toBe("0 0 */1 * *");
	});

	it("rounds half values upward for minutes-to-hours", () => {
		// 89m -> 1h, 90m -> 2h, 91m -> 2h (half-up at exactly 1.5)
		expect(normalizeInterval(req(89, "m", "89m")).value).toBe(1);
		expect(normalizeInterval(req(89, "m", "89m")).unit).toBe("h");
		expect(normalizeInterval(req(90, "m", "90m")).value).toBe(2);
		expect(normalizeInterval(req(91, "m", "91m")).value).toBe(2);
	});

	it("rounds half values upward for hours-to-days", () => {
		// 35h -> 1d, 36h -> 2d, 37h -> 2d
		expect(normalizeInterval(req(35, "h", "35h")).value).toBe(1);
		expect(normalizeInterval(req(35, "h", "35h")).unit).toBe("d");
		expect(normalizeInterval(req(36, "h", "36h")).value).toBe(2);
		expect(normalizeInterval(req(37, "h", "37h")).value).toBe(2);
	});

	it("seconds always ceil to minutes with a minimum of 1", () => {
		expect(normalizeInterval(req(1, "s", "1s"))).toEqual(
			eff(1, "m", "1 minute", true, "Requested 1s rounds to 1 minute."),
		);
		expect(normalizeInterval(req(59, "s", "59s")).value).toBe(1);
		expect(normalizeInterval(req(60, "s", "60s")).value).toBe(1);
		expect(normalizeInterval(req(61, "s", "61s")).value).toBe(2);
	});

	it("intervalMs matches the effective unit", () => {
		expect(normalizeInterval(req(5, "m", "5m")).intervalMs).toBe(5 * 60_000);
		expect(normalizeInterval(req(90, "m", "90m")).intervalMs).toBe(2 * 60 * 60_000);
		expect(normalizeInterval(req(36, "h", "36h")).intervalMs).toBe(2 * 24 * 60 * 60_000);
		expect(normalizeInterval(req(1, "d", "1d")).intervalMs).toBe(24 * 60 * 60_000);
	});
});

describe("describeCron", () => {
	it("produces restricted minute, hour, and day forms only", () => {
		expect(describeCron({ value: 5, unit: "m" })).toBe("*/5 * * * *");
		expect(describeCron({ value: 2, unit: "h" })).toBe("0 */2 * * *");
		expect(describeCron({ value: 3, unit: "d" })).toBe("0 0 */3 * *");
	});
});

describe("computeNextFireAt", () => {
	it("returns nowMs + intervalMs without reading the clock", () => {
		expect(computeNextFireAt(1_000_000, 300_000)).toBe(1_300_000);
		expect(computeNextFireAt(0, 86_400_000)).toBe(86_400_000);
	});
});
