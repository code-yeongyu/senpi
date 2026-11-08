import { describe, expect, it } from "vitest";
import { accountFooterSuffix } from "../../../src/modes/interactive/components/footer.ts";

// senpi#5983: the footer named the pinned account even after a usage-limit
// refusal moved every later turn to a sibling, and it ignored the settings
// and CLI pins. These tests pin the block-aware pick at the footer boundary:
// the suffix must name the account that will serve, and mark a blocked pin.
function pooled(pinned?: string, blockedUntilByName?: Record<string, number>) {
	return {
		type: "api_key" as const,
		key: "key-default",
		accounts: [
			{
				name: "default",
				key: "key-default",
				source: "login" as const,
				...(blockedUntilByName?.["default"] === undefined ? {} : { blockedUntil: blockedUntilByName["default"] }),
			},
			{
				name: "work",
				key: "key-work",
				source: "login" as const,
				...(blockedUntilByName?.["work"] === undefined ? {} : { blockedUntil: blockedUntilByName["work"] }),
			},
		],
		...(pinned === undefined ? {} : { pinned }),
	};
}

function hhmm(until: number): string {
	const date = new Date(until);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

describe("accountFooterSuffix (senpi#5983)", () => {
	const now = Date.parse("2026-11-05T06:00:00Z");
	const blockedUntil = now + 3_600_000;

	it("names the serving sibling and marks the blocked pin", () => {
		const suffix = accountFooterSuffix(pooled("default", { default: blockedUntil }), "session-5983", { now });
		expect(suffix).toBe(`@work (default blocked until ${hhmm(blockedUntil)})`);
	});

	it("reflects a settings pin over the stored pin", () => {
		expect(accountFooterSuffix(pooled("work"), "session-5983", { pinnedAccount: "default" })).toBe("@default");
	});

	it("reflects a settings pin that itself is blocked", () => {
		const suffix = accountFooterSuffix(pooled("work", { default: blockedUntil }), "session-5983", {
			pinnedAccount: "default",
			now,
		});
		expect(suffix).toBe(`@work (default blocked until ${hhmm(blockedUntil)})`);
	});

	it("skips a blocked HRW winner for the next usable slot", () => {
		const winner = accountFooterSuffix(pooled(), "session-5983-winner");
		const winnerName = winner.slice(1);
		const otherName = winnerName === "default" ? "work" : "default";
		const suffix = accountFooterSuffix(pooled(undefined, { [winnerName]: blockedUntil }), "session-5983-winner", {
			now,
		});
		expect(suffix).toBe(`@${otherName}`);
	});

	it("names the pin with a blocked marker when every slot is blocked", () => {
		const suffix = accountFooterSuffix(
			pooled("default", { default: blockedUntil, work: blockedUntil }),
			"session-5983",
			{ now },
		);
		expect(suffix).toBe(`@default (blocked until ${hhmm(blockedUntil)})`);
	});

	it("treats an expired block as usable", () => {
		expect(accountFooterSuffix(pooled("default", { default: now - 1_000 }), "session-5983", { now })).toBe(
			"@default",
		);
	});
});
