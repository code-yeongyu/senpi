import { beforeAll, describe, expect, it } from "vitest";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "./helpers/footer-test-fixtures.ts";

function footerData(subagentCost: number | undefined): ReadonlyFooterDataProvider {
	return { ...createFooterData(1), getSubagentCost: () => subagentCost };
}

function renderCost(parentCost: number, subagentCost: number | undefined): string {
	const session = createFooterSession({
		sessionName: "",
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: parentCost } },
	});
	return new FooterComponent(session, footerData(subagentCost))
		.render(160)
		.map((line) => stripAnsi(line))
		.join("\n");
}

describe("FooterComponent subagent tree cost (#2471)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows the subagent tree's spend in brackets after the session's own cost", () => {
		expect(renderCost(0.38, 1.27)).toContain("$0.380 (+1.270)");
	});

	it("shows the bracket even when the session itself has spent nothing yet", () => {
		expect(renderCost(0, 0.5)).toContain("$0.000 (+0.500)");
	});

	it("shows no bracket when no subagent spend was reported", () => {
		const withoutReport = renderCost(0.38, undefined);
		const zeroSpend = renderCost(0.38, 0);
		expect(withoutReport).toContain("$0.380");
		expect(withoutReport).not.toContain("(+");
		expect(zeroSpend).not.toContain("(+");
	});
});

describe("FooterDataProvider subagent cost", () => {
	it("stores, replaces and clears the reported subagent spend", () => {
		const provider = new FooterDataProvider(process.cwd());
		try {
			expect(provider.getSubagentCost()).toBeUndefined();
			provider.setSubagentCost(0.25);
			provider.setSubagentCost(0.75);
			expect(provider.getSubagentCost()).toBe(0.75);
			provider.setSubagentCost(undefined);
			expect(provider.getSubagentCost()).toBeUndefined();
		} finally {
			provider.dispose();
		}
	});

	it("ignores a negative or non-finite spend instead of rendering it", () => {
		const provider = new FooterDataProvider(process.cwd());
		try {
			provider.setSubagentCost(Number.NaN);
			expect(provider.getSubagentCost()).toBeUndefined();
			provider.setSubagentCost(-1);
			expect(provider.getSubagentCost()).toBeUndefined();
		} finally {
			provider.dispose();
		}
	});
});
