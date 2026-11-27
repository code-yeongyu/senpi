import { describe, expect, it } from "vitest";
import { moveToMacTrash, trashedPathFromReport } from "../../src/core/extensions/builtin/delete-policy/macos.ts";

// The macOS backend runs /usr/bin/trash (the JXA NSFileManager call crashed from a background session, senpi#7578).
// Its report is the only source of the trashed path: a background session cannot list the Trash.
describe("macOS trash report", () => {
	it("reads the trashed path from trash -v, expanding ~ to the home directory", () => {
		const report = '# Moved "/tmp/run/probe.txt" to "~/.Trash/probe.txt"\n';
		expect(trashedPathFromReport(report, "/Users/someone")).toBe("/Users/someone/.Trash/probe.txt");
	});

	it("keeps an absolute trashed path on another volume as reported", () => {
		const report = '# Moved "/Volumes/Data/x" to "/Volumes/Data/.Trashes/501/x"';
		expect(trashedPathFromReport(report, "/Users/someone")).toBe("/Volumes/Data/.Trashes/501/x");
	});

	it("reports nothing when the tool printed no move", () => {
		expect(trashedPathFromReport("trash: /tmp/x: No such file or directory\n", "/Users/someone")).toBeUndefined();
	});

	it("refuses without deleting when the trash tool is missing", async () => {
		await expect(moveToMacTrash("/tmp/never-touched", "/nonexistent/trash")).rejects.toMatchObject({
			code: "no_trash",
		});
	});
});
