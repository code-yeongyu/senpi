import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "./helpers/footer-test-fixtures.ts";

function pooledCredential(displayName?: string) {
	const slot = {
		name: "second",
		access: "fake-a",
		refresh: "fake-r",
		expires: 4_102_444_800_000,
		source: "login" as const,
		...(displayName === undefined ? {} : { displayName }),
	};
	return {
		type: "oauth" as const,
		access: "fake-a",
		refresh: "fake-r",
		expires: 4_102_444_800_000,
		pinned: "second",
		accounts: [{ ...slot, name: "default" }, slot],
	};
}

// senpi#1495 review finding 1: a display name may legally contain `)` and `:`;
// the footer must colour its segments from the values that produced them, not
// by re-parsing the rendered string.
describe("FooterComponent account display names", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps the provider prefix muted and the model accented when the label contains ) and :", () => {
		const width = 120;
		const session = createFooterSession({
			sessionName: "",
			modelId: "gpt-5-codex",
			provider: "openai-codex",
			reasoning: true,
			thinkingLevel: "high",
			credential: pooledCredential("Work: dev (b)"),
		});
		const footer = new FooterComponent(session, createFooterData(2));
		const lines = footer.render(width);
		const plain = stripAnsi(lines[0] ?? "");

		expect(plain).toContain("@Work: dev (b) (second)");
		expect(plain).toContain("gpt-5-codex:high");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);

		// The exact colouring: muted "(provider@label) " run, accented model id,
		// dim ":high". A regex over the rendered string would paint the whole
		// segment with the model accent instead.
		const providerRun = theme.fg("muted", "(openai-codex@Work: dev (b) (second)) ");
		const modelRun = theme.fg("accent", "gpt-5-codex");
		const thinkingRun = theme.fg("dim", ":high");
		expect(lines[0]).toContain(`${providerRun}${modelRun}${thinkingRun}`);
	});

	it("renders an unnamed account identically to before", () => {
		const width = 120;
		const session = createFooterSession({
			sessionName: "",
			modelId: "gpt-5-codex",
			provider: "openai-codex",
			reasoning: true,
			thinkingLevel: "high",
			credential: pooledCredential(),
		});
		const footer = new FooterComponent(session, createFooterData(2));
		const lines = footer.render(width);
		expect(stripAnsi(lines[0] ?? "")).toContain("(openai-codex@second)");
		expect(lines[0]).toContain(
			`${theme.fg("muted", "(openai-codex@second) ")}${theme.fg("accent", "gpt-5-codex")}${theme.fg("dim", ":high")}`,
		);
	});

	it("truncates a wide label with an ellipsis instead of dropping the account segment", () => {
		const width = 110;
		const session = createFooterSession({
			sessionName: "",
			modelId: "gpt-5-codex",
			provider: "openai-codex",
			reasoning: true,
			thinkingLevel: "high",
			// 32 terminal columns of CJK: legal to store, too wide for the footer.
			credential: pooledCredential("中".repeat(16)),
		});
		const footer = new FooterComponent(session, createFooterData(2));
		const lines = footer.render(width);
		const plain = stripAnsi(lines[0] ?? "");
		// The 24-column account-label bound keeps the provider segment viable;
		// without it the full right side would not fit and the plan would fall
		// back to right.minimal, hiding the account indicator entirely.
		expect(plain).toContain("(openai-codex@");
		expect(plain).toContain("…");
		expect(plain).toContain("gpt-5-codex:high");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
