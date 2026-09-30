import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { accountFooterSuffix } from "../src/modes/interactive/components/footer.ts";

function pooled(pinned?: string) {
	return {
		type: "api_key" as const,
		key: "key-default",
		accounts: [
			{ name: "default", key: "key-default", source: "login" as const },
			{ name: "work", key: "key-work", source: "login" as const },
		],
		...(pinned === undefined ? {} : { pinned }),
	};
}

describe("accountFooterSuffix", () => {
	it("stays empty for a flat single credential (no pool, no noise)", () => {
		expect(accountFooterSuffix({ type: "api_key", key: "sk-flat" }, "session-1")).toBe("");
		expect(accountFooterSuffix(undefined, "session-1")).toBe("");
	});

	it("names the pinned account when one is pinned", () => {
		expect(accountFooterSuffix(pooled("work"), "session-1")).toBe("@work");
	});

	it("falls back to the session's HRW winner and stays session-stable", () => {
		const first = accountFooterSuffix(pooled(), "session-stable");
		expect(first).toMatch(/^@(default|work)$/);
		expect(accountFooterSuffix(pooled(), "session-stable")).toBe(first);
	});

	it("ignores a pin that names a missing slot", () => {
		const suffix = accountFooterSuffix(pooled("ghost"), "session-1");
		expect(suffix).toMatch(/^@(default|work)$/);
	});

	it("never contains key material", () => {
		expect(accountFooterSuffix(pooled("work"), "session-1")).not.toContain("key-");
	});

	it("shows a verified email shorthand beside the pinned slot ID", () => {
		const credential = {
			type: "oauth" as const,
			access: "fake-default",
			refresh: "fake-default-refresh",
			expires: 1,
			pinned: "login-2",
			accounts: [
				{ name: "default", access: "fake-default", refresh: "fake-default-refresh", expires: 1 },
				{
					name: "login-2",
					access: "fake-research",
					refresh: "fake-research-refresh",
					expires: 1,
					verifiedIdentity: {
						userId: "user-research",
						workspaceId: "workspace-research",
						verifiedEmail: "research@astrabit.io",
					},
				},
			],
		};

		expect(accountFooterSuffix(credential, "session-1")).toBe("@research (login-2)");
		expect(accountFooterSuffix(credential, "session-1")).not.toContain("fake-research");
	});

	it("retains the pinned slot ID when a manual label exceeds the footer width", () => {
		const credential = {
			...pooled("work"),
			accounts: pooled("work").accounts.map((slot) =>
				slot.name === "work" ? { ...slot, displayName: "LongResearchTeamName" } : slot,
			),
		};

		const suffix = accountFooterSuffix(credential, "session-1");

		expect(suffix.endsWith("(work)")).toBe(true);
		expect(visibleWidth(suffix)).toBeLessThanOrEqual(25);
	});
});
