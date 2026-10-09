import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMovedBreadcrumb } from "../../src/core/extensions/builtin/moved-path-guard/breadcrumb.ts";
import { matchMovedPrefix } from "../../src/core/extensions/builtin/moved-path-guard/path-match.ts";

/**
 * code-yeongyu/senpi#2898: the `omo-desktop-moved.json` breadcrumb is a cross-repo contract with the OmO
 * desktop (code-yeongyu/omo-desktop-app#1829). Both repos commit the same v1 fixture and must accept it the
 * same way; this pins senpi's half of that contract and the path rules both sides share.
 */

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "moved-path-guard", "omo-desktop-moved.v1.json");

function fixture(): Record<string, unknown> {
	return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

describe("breadcrumb contract (#2898)", () => {
	it("accepts the committed v1 fixture and keeps every listed prefix", () => {
		const parsed = parseMovedBreadcrumb(fixture(), posix);
		expect(parsed.kind).toBe("valid");
		if (parsed.kind !== "valid") return;
		expect(parsed.breadcrumb.movedTo).toBe("/home/user/.omo/desktop");
		expect(parsed.breadcrumb.moved).toEqual([
			["worktrees", "app", "w1"],
			["worktrees", "app", "w2"],
			["userdata", "omo-sessions"],
			["userdata", "senpi-sessions"],
			["dev", "userdata", "omo-sessions"],
			["dev", "userdata", "senpi-sessions"],
		]);
	});

	it("treats a higher schemaVersion as no breadcrumb", () => {
		expect(parseMovedBreadcrumb({ ...fixture(), schemaVersion: 2 }, posix).kind).toBe("ignored");
	});

	it.each([
		["a foreign kind", { kind: "something-else" }],
		["a relative movedTo", { movedTo: "relative/desktop" }],
		["a prefix that climbs out", { moved: ["worktrees/../../etc"] }],
		["an absolute prefix", { moved: ["/etc"] }],
		["an empty prefix", { moved: ["."] }],
		["a non-array moved", { moved: "worktrees/app/w1" }],
		["schemaVersion 0", { schemaVersion: 0 }],
	])("ignores %s", (_label, override) => {
		expect(parseMovedBreadcrumb({ ...fixture(), ...override }, posix).kind).toBe("ignored");
	});
});

describe("moved prefix matching (#2898)", () => {
	const moved = [
		["worktrees", "app"],
		["userdata", "omo-sessions"],
	] as const;

	it("matches on a path boundary only", () => {
		expect(matchMovedPrefix("/h/.t3/worktrees/app/src/a.ts", "/h/.t3", moved, "posix")?.remainder).toEqual([
			"worktrees",
			"app",
			"src",
			"a.ts",
		]);
		expect(matchMovedPrefix("/h/.t3/worktrees/app", "/h/.t3", moved, "posix")).toBeDefined();
		expect(matchMovedPrefix("/h/.t3/worktrees/app-x/a.ts", "/h/.t3", moved, "posix")).toBeUndefined();
		expect(matchMovedPrefix("/h/.t3/worktrees", "/h/.t3", moved, "posix")).toBeUndefined();
		expect(matchMovedPrefix("/h/.t3x/worktrees/app", "/h/.t3", moved, "posix")).toBeUndefined();
	});

	it("is case-sensitive on linux and case-insensitive on darwin", () => {
		expect(matchMovedPrefix("/h/.T3/Worktrees/App/a.ts", "/h/.t3", moved, "posix")).toBeUndefined();
		expect(matchMovedPrefix("/h/.T3/Worktrees/App/a.ts", "/h/.t3", moved, "darwin")?.remainder).toEqual([
			"Worktrees",
			"App",
			"a.ts",
		]);
	});

	it("treats win32 case, both separators, and the \\\\?\\ prefix as one path", () => {
		const root = "C:\\Users\\U\\.t3";
		for (const path of [
			"c:/users/u/.T3/WORKTREES/app/src/a.ts",
			"C:\\Users\\U\\.t3\\worktrees\\App\\src\\a.ts",
			"\\\\?\\C:\\Users\\U\\.t3\\worktrees\\app\\src\\a.ts",
		]) {
			expect(matchMovedPrefix(path, root, moved, "win32")?.remainder.slice(2)).toEqual(["src", "a.ts"]);
		}
		expect(matchMovedPrefix("C:\\Users\\U\\.t3\\worktrees\\app-x\\a.ts", root, moved, "win32")).toBeUndefined();
		expect(matchMovedPrefix("D:\\Users\\U\\.t3\\worktrees\\app\\a.ts", root, moved, "win32")).toBeUndefined();
	});
});
