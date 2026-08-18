import { expect, test, vi } from "vitest";
import { printHelp } from "../../../src/cli/args.ts";

test("lists the public PI_RULES environment settings in top-level help", () => {
	// Given: the top-level help output is captured without loading extension flags.
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

	try {
		// When: the CLI renders its built-in help surface.
		printHelp(undefined, false);
		const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");

		// Then: every public rules setting is discoverable by name.
		expect(output).toContain("PI_RULES_DISABLED");
		expect(output).toContain("PI_RULES_MAX_RULE_CHARS");
		expect(output).toContain("PI_RULES_MAX_RESULT_CHARS");
	} finally {
		logSpy.mockRestore();
	}
});
