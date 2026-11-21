import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalPathCase } from "../../src/core/extensions/builtin/permission-system/external-pattern.ts";

// senpi#7150: the external_directory decision recovers case on the engine's main thread, and listing a directory opens
// it. On a wedged mount (the macOS /home autofs trigger) that open never returns and freezes the engine, so case
// recovery may list a directory only when the listing can change the spelling.
describe("7150 case recovery lists only directories that can change the spelling", () => {
	let root: string;
	let wedged: string;
	let opened: string[];
	const listDirectory = (directory: string): string[] => {
		if (directory === wedged) {
			opened.push(directory);
			throw Object.assign(new Error(`EWEDGED: opening ${directory} would block`), { code: "EWEDGED" });
		}
		return readdirSync(directory);
	};
	const caseInsensitive = (path: string) => {
		try {
			return lstatSync(path.toUpperCase()).ino === lstatSync(path).ino;
		} catch {
			return false;
		}
	};

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-wedged-")));
		wedged = join(root, "wedged");
		opened = [];
		mkdirSync(join(wedged, "present"), { recursive: true });
		writeFileSync(join(wedged, "present", "f.txt"), "fixture");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("ends at a missing component without listing its parent", () => {
		const path = join(wedged, "missing", "f.txt");
		expect(canonicalPathCase(path, listDirectory)).toBe(path);
		expect(opened).toEqual([]);
	});

	it("keeps an existing component on a case-sensitive directory without listing it", (context) => {
		const path = join(wedged, "present", "f.txt");
		if (caseInsensitive(join(wedged, "present"))) return context.skip();
		expect(canonicalPathCase(path, listDirectory)).toBe(path);
		expect(opened).toEqual([]);
	});

	it("still recovers the on-disk spelling on a case-insensitive directory", (context) => {
		if (!caseInsensitive(join(wedged, "present"))) return context.skip();
		expect(canonicalPathCase(join(wedged, "PRESENT", "f.txt"), readdirSync)).toBe(join(wedged, "present", "f.txt"));
	});
});
