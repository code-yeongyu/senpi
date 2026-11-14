/**
 * How two spellings of one folder compare: a Windows drive letter in either case is the same drive, the rest of the
 * path is compared as written, and a bare root keeps its separator.
 */
import { describe, expect, it } from "vitest";
import { comparableFolder } from "../../src/modes/rpc/project-expected-cwd.ts";

describe("comparableFolder", () => {
	it("treats a drive letter's case as the same drive", () => {
		expect(comparableFolder("c:\\w\\app")).toBe(comparableFolder("C:\\w\\app"));
	});

	it("keeps the rest of a Windows path as written", () => {
		expect(comparableFolder("C:\\w\\App")).not.toBe(comparableFolder("C:\\w\\app"));
	});

	it("keeps a bare root's separator", () => {
		expect(comparableFolder("/")).toBe("/");
		expect(comparableFolder("C:\\")).toBe("C:\\");
		expect(comparableFolder("C:\\")).toBe(comparableFolder("c:\\"));
	});
});
