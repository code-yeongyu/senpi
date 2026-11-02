import * as nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findRuleCandidates } from "../../../src/core/extensions/builtin/rules/rules/finder.ts";

const {
	projectRoot,
	crossDriveTarget,
	crossDriveAgentsMd,
	caseVariantTarget,
	aboveRootAgentsMd,
	homeDir,
	existingFiles,
} = vi.hoisted(() => ({
	projectRoot: "C:\\workspace\\proj",
	crossDriveTarget: "D:\\other\\file.ts",
	crossDriveAgentsMd: "D:\\other\\AGENTS.md",
	caseVariantTarget: "c:\\workspace\\proj\\src\\file.ts",
	aboveRootAgentsMd: "c:\\workspace\\AGENTS.md",
	homeDir: "C:\\Users\\test",
	existingFiles: new Set<string>(),
}));

vi.mock("node:fs", () => ({
	existsSync: (path: string) => existingFiles.has(path),
	statSync: () => ({ isFile: () => true, isDirectory: () => false }),
	lstatSync: () => ({ isSymbolicLink: () => false }),
	readdirSync: () => [],
	realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
}));

vi.mock("node:path", async (importOriginal) => {
	const path = (await importOriginal()) as typeof nodePath;
	return {
		...path,
		dirname: path.win32.dirname,
		isAbsolute: path.win32.isAbsolute,
		join: path.win32.join,
		relative: path.win32.relative,
		resolve: path.win32.resolve,
	};
});

describe("rules finder cross-drive project scope", () => {
	beforeEach(() => {
		existingFiles.clear();
	});

	it("#given a target file on a different drive than the project root #when collecting project rule candidates #then rules outside the project root are not collected", () => {
		// given
		existingFiles.add(crossDriveAgentsMd);
		expect(nodePath.win32.relative(projectRoot, "D:\\other")).toBe("D:\\other");

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

	it("#given a target whose drive letter case differs from the project root #when collecting project rule candidates #then the walk stops at the project root", () => {
		// given
		existingFiles.add(aboveRootAgentsMd);
		expect(nodePath.win32.relative(projectRoot, "c:\\workspace\\proj")).toBe("");

		// when
		const candidates = findRuleCandidates({
			projectRoot,
			targetFile: caseVariantTarget,
			homeDir,
			skipUserHome: true,
		});

		// then
		expect(candidates.map((candidate) => candidate.path)).toEqual([]);
	});
});
