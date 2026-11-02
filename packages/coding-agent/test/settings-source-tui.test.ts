import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode settings source notice", () => {
	it("renders one concise JSONC status for one source-selection event", () => {
		const showStatus = vi.fn();
		const fakeThis = { showStatus };
		const event = {
			type: "settings_source_selected",
			path: "/tmp/sandbox/agent/settings.jsonc",
			format: "jsonc",
			reason: "explicit-jsonc",
			scope: "global",
		};

		(
			InteractiveMode as unknown as {
				prototype: { showSettingsSourceSelected(this: unknown, event: unknown): void };
			}
		).prototype.showSettingsSourceSelected.call(fakeThis, event);

		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Settings: settings.jsonc (JSONC)");
	});
});
