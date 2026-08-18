import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findRuleCandidates } from "../../../src/core/extensions/builtin/rules/rules/finder.ts";

const { projectRoot, crossDriveTarget, crossDriveAgentsMd, homeDir } = vi.hoisted(() => ({
	projectRoot: "C:\\workspace\\proj",
	crossDriveTarget: "D:\\other\\file.ts",
	crossDriveAgentsMd: "D:\\other\\AGENTS.md",
	homeDir: "C:\\Users\\test",
}));

vi.mock("node:fs", () => ({
	existsSync: (path: string) => path === crossDriveAgentsMd,
	statSync: () => ({ isFile: () => true, isDirectory: () => false }),
	lstatSync: () => ({ isSymbolicLink: () => false }),
	readdirSync: () => [],
	realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
}));

vi.mock("node:path", async (importOriginal) => {
	const path = await importOriginal<typeof import("node:path")>();
	return {
		...path,
		dirname: path.win32.dirname,
		join: path.win32.join,
		relative: path.win32.relative,
		resolve: path.win32.resolve,
	};
});

describe("rules finder cross-drive project scope", () => {
	it("#given a target file on a different drive than the project root #when collecting project rule candidates #then rules outside the project root are not collected", () => {
		// given
		expect(win32.relative(projectRoot, "D:\\other")).toBe("D:\\other");

		// when
		const candidates = findRuleCandidates({
			projectRoot,
			targetFile: crossDriveTarget,
			homeDir,
			skipUserHome: true,
		});

		// then
		expect(candidates.map((candidate) => candidate.path)).toEqual([]);
	});
});
