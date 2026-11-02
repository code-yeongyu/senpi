import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
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
