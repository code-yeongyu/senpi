import { describe, expect, it } from "vitest";
import { COMPUTER_TIPS } from "../../src/modes/interactive/tips/catalog/computer-tips.ts";
import { TIP_DEFINITIONS } from "../../src/modes/interactive/tips/registry.ts";

describe("computer tips", () => {
	it("registers every computer tip", () => {
		const ids = new Set(TIP_DEFINITIONS.map((tip) => tip.id));

		for (const tip of COMPUTER_TIPS) {
			expect(ids, `missing ${tip.id}`).toContain(tip.id);
		}
	});

	it("shows computer tips only where the /computer command exists", () => {
		const computerTips = TIP_DEFINITIONS.filter((tip) => tip.id.startsWith("computer."));

		expect(computerTips.length).toBe(COMPUTER_TIPS.length);
		for (const tip of computerTips) {
			expect({ id: tip.id, requiresCommand: tip.requiresCommand }).toEqual({
				id: tip.id,
				requiresCommand: "computer",
			});
		}
	});
});
