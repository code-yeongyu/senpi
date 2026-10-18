import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalPathResolver } from "../src/modes/interactive/components/session-selector-tree.ts";
import { canonicalizePath } from "../src/utils/paths.ts";

describe("session selector canonical path resolver", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("answers exactly what canonicalizePath answers, on first and repeated lookups", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-session-tree-"));
		tempDirs.push(baseDir);
		const realDir = join(baseDir, "real");
		mkdirSync(realDir);
		writeFileSync(join(realDir, "a.jsonl"), "a\n");
		symlinkSync(realDir, join(baseDir, "alias"));

		const paths = [join(baseDir, "alias", "a.jsonl"), join(realDir, "a.jsonl"), join(baseDir, "missing.jsonl")];
		const resolve = createCanonicalPathResolver();

		for (const path of [...paths, ...paths]) {
			expect(resolve(path)).toBe(canonicalizePath(path));
		}
		expect(resolve(paths[0])).toBe(resolve(paths[1]));
		expect(resolve(undefined)).toBeUndefined();
		expect(resolve("")).toBe("");
	});
});
