import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import {
	type FooterRightForm,
	type FooterSegment,
	planFooterLayout,
} from "../src/modes/interactive/components/footer-layout.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import {
	createFooterData,
	createFooterSession as createFooterSessionFixture,
	type FooterSessionOptions,
} from "./helpers/footer-test-fixtures.ts";

function createFooterSession(options: FooterSessionOptions) {
	const session = createFooterSessionFixture(options);
	Object.assign(session, { modelRuntime: { isUsingSubscription: () => false } });
	return session;
}

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

	it("shows the physical model a virtual model routed to", () => {
		const session = createFooterSession({
			sessionName: "",
			modelId: "auto",
			reasoning: true,
			thinkingLevel: "high",
		});
		Object.assign(session, { routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" } });
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[0]);

		expect(statsLine).toContain("auto \u2192 gpt-5.6-luna:medium \u2022 effort high");
	});

	it("updates usage totals after an entry is appended", () => {
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
		const session = createFooterSession({ sessionName: "", usage });
		const footer = new FooterComponent(session, createFooterData(1));
		expect(stripAnsi(footer.render(120)[0])).toContain("$0.500");

		session.sessionManager.getEntries().push({ type: "message", message: { role: "assistant", usage } } as never);
		expect(stripAnsi(footer.render(120)[0])).toContain("$1.000");
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
		expect(plain).toContain("(test) test-model \u2022 effort high");
	});
});

function seg(plain: string): FooterSegment {
	return { plain, colored: plain };
}

describe("planFooterLayout provider priority", () => {
	const anchor: [FooterSegment, ...FooterSegment[]] = [seg("~/local-workspaces/senpi"), seg("main")];
	const middle = [seg("session-name"), seg("↑1.2M"), seg("↓45K"), seg("CH92.3%"), seg("$12.345")];
	const tail = seg("120K/1M (12.0%) (auto)");
	const right = {
		forms: [
			{ ...seg("(anthropic) claude-opus-5:low"), fitsWith: "middle-elision" as const },
			seg("claude-opus-5:low"),
		] as [FooterRightForm, ...FooterRightForm[]],
	};
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
		expect(plan.rightForm).toBe(0);
	});

	it("falls back to the bare model label when even empty middle cannot fit the full label", () => {
		const plan = planFooterLayout({ ...baseInput, width: 75 });
		expect(plan.kind).toBe("middle-elided");
		if (plan.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(plan.keptMiddleCount).toBe(0);
		expect(plan.showMarker).toBe(false);
		expect(plan.rightForm).toBe(1);
	});

	it("accepts a form that must fit with everything only in the full layout", () => {
		const ladder = {
			forms: [
				{ ...seg("(anthropic) claude-opus-5 • effort low (shift+tab)"), fitsWith: "everything" as const },
				{ ...seg("(anthropic) claude-opus-5 • effort low"), fitsWith: "everything" as const },
				{ ...seg("(anthropic) claude-opus-5:low"), fitsWith: "middle-elision" as const },
				seg("claude-opus-5:low"),
			] as [FooterRightForm, ...FooterRightForm[]],
		};
		const everything = planFooterLayout({ ...baseInput, right: ladder, width: 160 });
		expect(everything).toEqual({ kind: "full", rightForm: 0 });

		const oneStatShort = planFooterLayout({ ...baseInput, right: ladder, width: 130 });
		expect(oneStatShort.kind).toBe("middle-elided");
		if (oneStatShort.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(oneStatShort.rightForm).toBe(2);
		expect(oneStatShort.keptMiddleCount).toBeGreaterThan(0);
	});

	it("lets the level-bearing floor shorten the path instead of dropping the level", () => {
		const ladder = {
			forms: [
				{ ...seg("(anthropic) claude-opus-5 • effort low"), fitsWith: "everything" as const },
				{ ...seg("(anthropic) claude-opus-5:low"), fitsWith: "middle-elision" as const },
				seg("claude-opus-5:low"),
			] as [FooterRightForm, ...FooterRightForm[]],
		};
		const plan = planFooterLayout({ ...baseInput, right: ladder, width: 62 });
		expect(plan.kind).toBe("pwd-elided");
		if (plan.kind !== "pwd-elided") throw new Error("unexpected plan");
		expect(plan.rightForm).toBe(2);
		expect(plan.pwdPlain).toMatch(/^…/);
	});

	it("keeps the existing pwd-elided and anchor/tail guarantees untouched", () => {
		const plan = planFooterLayout({ ...baseInput, width: 60 });
		expect(plan.kind).toBe("pwd-elided");
		if (plan.kind !== "pwd-elided") throw new Error("unexpected plan");
		expect(plan.pwdPlain.length).toBeGreaterThan(0);
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createFooterSession({ sessionName: "", provider: "anthropic" });
		Object.assign(session, { modelRuntime: { isUsingSubscription: () => true } });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[0])).toContain("$0.000 (sub)");
	});

	it("does not mark non-subscription auth as a subscription", () => {
		const session = createFooterSession({
			sessionName: "",
			provider: "openrouter",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 1.234 } },
		});
		Object.assign(session, { modelRuntime: { isUsingSubscription: () => false } });
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[0]);

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});
});
