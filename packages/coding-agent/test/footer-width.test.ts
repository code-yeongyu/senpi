import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { type FooterSegment, planFooterLayout } from "../src/modes/interactive/components/footer-layout.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "./helpers/footer-test-fixtures.ts";

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createFooterSession({ sessionName: "中文".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createFooterSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "供應商",
			reasoning: true,
			thinkingLevel: "high",
			usage: { input: 12_345, output: 6_789, cacheRead: 0, cacheWrite: 0, cost: { total: 1.234 } },
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the model label and context block visible at narrow widths", () => {
		const width = 60;
		const session = createFooterSession({
			sessionName: "deep-work-on-footer-layout",
			modelId: "test-model",
			reasoning: true,
			thinkingLevel: "high",
			usage: { input: 12_345, output: 6_789, cacheRead: 50, cacheWrite: 50, cost: { total: 1.234 } },
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		const plain = lines.map((line) => stripAnsi(line)).join("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(plain).toContain("test-model:high");
		expect(plain).toContain("main");
		expect(plain).toContain("(auto)");
		expect(plain).toContain("…");
	});

	it("elides the path before hiding cache and cost stats", () => {
		const width = 110;
		const session = createFooterSession({
			sessionName: "",
			modelId: "test-model",
			provider: "test",
			reasoning: true,
			thinkingLevel: "high",
			cwd: "/workspace/client/platform/services/senpi/packages/coding-agent",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		const plain = lines.map((line) => stripAnsi(line)).join("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(plain).toContain("CH25.0%");
		expect(plain).toContain("$1.234");
		expect(plain).toContain("test-model:high");
		expect(plain).toMatch(/^…/);
		expect(plain).toContain("coding-agent");
		expect(plain).not.toContain("/workspace/client");
	});

	it("still renders the model label at very narrow widths", () => {
		const width = 30;
		const session = createFooterSession({
			sessionName: "deep-work-on-footer-layout",
			modelId: "test-model",
			reasoning: true,
			thinkingLevel: "high",
			usage: { input: 12_345, output: 6_789, cacheRead: 50, cacheWrite: 50, cost: { total: 1.234 } },
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		const plain = lines.map((line) => stripAnsi(line)).join("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(plain).toContain("test-model");
	});

	it("renders the provider prefix when more than one provider is available", () => {
		const width = 200;
		const session = createFooterSession({
			sessionName: "session-name",
			modelId: "test-model",
			reasoning: true,
			thinkingLevel: "high",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 1.234 } },
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		const plain = lines.map((line) => stripAnsi(line)).join("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(plain).toContain("(test) test-model:high");
	});
});

function seg(plain: string): FooterSegment {
	return { plain, colored: plain };
}

describe("planFooterLayout provider priority", () => {
	const anchor: [FooterSegment, ...FooterSegment[]] = [seg("~/local-workspaces/senpi"), seg("main")];
	const middle = [seg("session-name"), seg("↑1.2M"), seg("↓45K"), seg("CH92.3%"), seg("$12.345")];
	const tail = seg("120K/1M (12.0%) (auto)");
	const right = { minimal: seg("claude-opus-5:low"), full: seg("(anthropic) claude-opus-5:low") };
	const baseInput = {
		anchor,
		pwdIndex: 0,
		middle,
		tail,
		right,
		separator: " • ",
		minPadding: 2,
		ellipsisMarker: seg("…"),
	};

	it("keeps the provider prefix once a middle stat has to elide", () => {
		const plan = planFooterLayout({ ...baseInput, width: 124 });
		expect(plan.kind).toBe("middle-elided");
		if (plan.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(plan.keptMiddleCount).toBe(3);
		expect(plan.showMarker).toBe(true);
		expect(plan.useFullRight).toBe(true);
	});

	it("falls back to the bare model label when even empty middle cannot fit the full label", () => {
		const plan = planFooterLayout({ ...baseInput, width: 75 });
		expect(plan.kind).toBe("middle-elided");
		if (plan.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(plan.keptMiddleCount).toBe(0);
		expect(plan.showMarker).toBe(false);
		expect(plan.useFullRight).toBe(false);
	});

	it("keeps the existing pwd-elided and anchor/tail guarantees untouched", () => {
		const plan = planFooterLayout({ ...baseInput, width: 60 });
		expect(plan.kind).toBe("pwd-elided");
		if (plan.kind !== "pwd-elided") throw new Error("unexpected plan");
		expect(plan.pwdPlain.length).toBeGreaterThan(0);
	});
});
