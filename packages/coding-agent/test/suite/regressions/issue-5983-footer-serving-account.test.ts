import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { FooterComponent, accountFooterSuffix } from "../../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "../../helpers/footer-test-fixtures.ts";

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

// senpi#6222 review: the Anthropic CLI/settings pin must not leak into a
// non-Anthropic pooled provider. A slot that shares the Anthropic pin's name
// ("default") was named by the footer and overrode that provider's own
// stored pin, though its rotation never sees the Anthropic pin. The pin is
// resolved only when the current model uses the Anthropic subscription
// provider; otherwise the provider's stored pin stands.
describe("FooterComponent resolveAccountPin provider gate (senpi#6222 review)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
		setKeybindings(new KeybindingsManager());
	});

	// Non-Anthropic pooled provider (openai-codex) with slots "default"/"work"
	// and stored pin "work"; the Anthropic pin is "default".
	function pooledCodexCredential() {
		const slot = (name: string) => ({
			name,
			access: "fake-a",
			refresh: "fake-r",
			expires: 4_102_444_800_000,
			source: "login" as const,
		});
		return {
			type: "oauth" as const,
			access: "fake-a",
			refresh: "fake-r",
			expires: 4_102_444_800_000,
			pinned: "work",
			accounts: [slot("default"), slot("work")],
		};
	}

	function renderFooter(provider: string, modelId: string): string {
		const session = createFooterSession({
			sessionName: "",
			modelId,
			provider,
			credential: pooledCodexCredential(),
		});
		const footer = new FooterComponent(session, createFooterData(2), {
			resolveAccountPin: () => "default",
		});
		return stripAnsi(footer.render(120)[0] ?? "");
	}

	it("keeps the provider's own stored pin for a same-named non-Anthropic slot", () => {
		const plain = renderFooter("openai-codex", "gpt-5-codex");
		expect(plain).toContain("(openai-codex@work)");
		expect(plain).not.toContain("@default");
	});

	it("still applies the Anthropic pin for the Anthropic subscription provider", () => {
		const plain = renderFooter("anthropic-subscription", "claude-sonnet-5-5");
		expect(plain).toContain("(anthropic-subscription@default)");
	});
});
