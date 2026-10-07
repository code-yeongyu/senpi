import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { GrokWelcomeCard } from "../src/modes/interactive/grok/welcome-card.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme();

describe("GrokWelcomeCard", () => {
	it("prefixes release versions with v", () => {
		const lines = new GrokWelcomeCard("OmO", "5.0.1").render(80);
		expect(lines.join("\n")).toContain("OmO v5.0.1");
	});

	it("renders branded build labels without a v prefix", () => {
		const label = "omo@c6e7dd7 2026-09-04 10:17 +09:00";
		const lines = new GrokWelcomeCard("OmO", label).render(80);
		expect(lines.join("\n")).toContain(label);
		expect(lines.join("\n")).not.toContain(`v${label}`);
	});

	it("keeps every line within the terminal width", () => {
		const lines = new GrokWelcomeCard("OmO", "omo@c6e7dd7 2026-09-04").render(12);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		}
	});
});
