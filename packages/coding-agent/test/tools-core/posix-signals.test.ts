import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { posixSignalTable } from "../../src/core/tools/posix-signals.ts";

// Platform contract: a worker-side bash reports a signal-killed shell as 128 + n with the machine's own numbering,
// the number the local tool reads from os.constants.signals on that platform.
describe("posixSignalTable", () => {
	it.runIf(process.platform === "linux" || process.platform === "darwin")(
		"numbers every signal Node knows on this platform the way Node does",
		() => {
			const table = posixSignalTable(process.platform);
			const missing = Object.entries(constants.signals).filter(([name, number]) => table?.[name] !== number);
			expect(missing).toEqual([]);
		},
	);

	it("has no POSIX numbering for Windows", () => {
		expect(posixSignalTable("win32")).toBeUndefined();
	});
});
