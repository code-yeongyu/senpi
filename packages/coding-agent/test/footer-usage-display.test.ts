import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "./helpers/footer-test-fixtures.ts";

describe("FooterComponent usage display", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createFooterSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const renderedFooter = footer
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(renderedFooter).toContain("$1.250");
	});

	it("#given a total that includes a turn with no known price #when the footer renders #then the amount is marked as a lower bound (senpi#3844)", () => {
		// given
		const session = createFooterSession({
			sessionName: "",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
			toolUsage: { input: 15, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, costUnknown: true },
		});

		// when
		const renderedFooter = new FooterComponent(session, createFooterData(1))
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");

		// then
		expect(renderedFooter).toContain("$0.500+?");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createFooterSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const renderedFooter = footer
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(renderedFooter).toContain("CH25.0%");
		expect(renderedFooter).not.toContain("cache 50/50");
		expect(renderedFooter).not.toContain("cache ");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createFooterSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const renderedFooter = footer
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(renderedFooter).toContain("$1.234 (sub)");
	});
});
