import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession as createFooterSessionFixture } from "./helpers/footer-test-fixtures.ts";

function createFooterSession(sessionName: string, options: { reasoning?: boolean; thinkingLevel?: string } = {}) {
	const session = createFooterSessionFixture({ sessionName, ...options });
	Object.assign(session, { modelRuntime: { isUsingSubscription: () => false } });
	return session;
}

describe("FooterComponent SDK delegation marker", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows the (SDK) marker while a delegation episode is active and drops it after", () => {
		const footer = new FooterComponent(createFooterSession("s"), createFooterData(1));

		expect(stripAnsi(footer.render(120).join("\n"))).not.toContain("(SDK)");

		footer.setCompactionDelegated(true);
		expect(stripAnsi(footer.render(120).join("\n"))).toContain("(SDK)");

		footer.setCompactionDelegated(false);
		expect(stripAnsi(footer.render(120).join("\n"))).not.toContain("(SDK)");
	});

	it("stays within the width budget with the marker present", () => {
		const footer = new FooterComponent(createFooterSession("中文".repeat(30)), createFooterData(2));
		footer.setCompactionDelegated(true);

		for (const width of [40, 60, 93]) {
			for (const line of footer.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("renders the complete (SDK) marker or omits it entirely at every width", () => {
		// Head elision must never leave fragments like "…SDK)" behind.
		const markerFragments = ["SDK)", "DK)", "K)"];
		// The reasoning label ("test-model:high") widens the pinned right side so the
		// left-elision budget lands inside the marker at narrow widths (reviewer repro).
		const sessions = [
			createFooterSession("s", { reasoning: true, thinkingLevel: "high" }),
			createFooterSession("中文".repeat(30), { reasoning: true, thinkingLevel: "high" }),
			createFooterSession("中文".repeat(30)),
		];
		for (const session of sessions) {
			const footer = new FooterComponent(session, createFooterData(2));
			footer.setCompactionDelegated(true);
			for (let width = 20; width <= 100; width++) {
				for (const line of footer.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					const plain = stripAnsi(line);
					if (plain.includes("(SDK)")) continue;
					expect(plain).not.toContain("SDK");
					for (const fragment of markerFragments) {
						expect(plain).not.toContain(fragment);
					}
				}
			}
		}
	});
});
