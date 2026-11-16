/**
 * How a file system folds names (senpi#6472), and which paths cannot all be files where it does. The probe is checked
 * against what the file system of a temporary folder really does with two such names, measured without the probe, so
 * the same test holds on a host that folds names and on one that keeps them apart.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MoveBundleInvalidError } from "../../src/core/session-move/bundle.ts";
import {
	type NameFolding,
	oneNameUnder,
	probeNameFolding,
	refuseNamesThatFold,
} from "../../src/core/session-move/name-folding.ts";

const root = mkdtempSync(join(tmpdir(), "senpi-name-folding-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const APART: NameFolding = { letterCase: false, unicodeForm: false };
const LETTER_CASE: NameFolding = { letterCase: true, unicodeForm: false };
const UNICODE_FORM: NameFolding = { letterCase: false, unicodeForm: true };
const BOTH: NameFolding = { letterCase: true, unicodeForm: true };

// A capital with a combining mark that has no composed form, whose lower case has one: H + macron below, and U+1E96.
const CAPITAL_WITH_MARK = "files/H\u0331";
const SMALL_WITH_MARK = "files/h\u0331";
const SMALL_COMPOSED = "files/\u1e96";

/** Whether writing both names in a new folder leaves one file: what the file system does, asked without the probe. */
function oneFileFor(first: string, second: string): boolean {
	const folder = mkdtempSync(join(root, "measured-"));
	writeFileSync(join(folder, first), "");
	writeFileSync(join(folder, second), "");
	return readdirSync(folder).length === 1;
}

describe("probeNameFolding", () => {
	it("#given a folder #then it answers what that file system does with names differing in letter case and in Unicode form, and leaves nothing behind", async () => {
		const folder = mkdtempSync(join(root, "probed-"));

		const folding = await probeNameFolding(folder);

		expect(folding).toEqual({
			letterCase: oneFileFor("Name", "name"),
			unicodeForm: oneFileFor("caf\u00e9", "cafe\u0301"),
		});
		expect(readdirSync(folder)).toEqual([]);
	});

	it("#given a path that is not there yet #then it probes the nearest folder above it that exists, and makes nothing on the way", async () => {
		const folder = mkdtempSync(join(root, "above-"));

		const folding = await probeNameFolding(join(folder, "not", "there", "yet"));

		expect(folding).toEqual(await probeNameFolding(folder));
		expect(readdirSync(folder)).toEqual([]);
	});
});

describe("oneNameUnder", () => {
	it.each<[string, readonly string[], NameFolding, boolean]>([
		[
			"two paths differing in letter case, where case folds",
			["files/Notes.txt", "files/notes.txt"],
			LETTER_CASE,
			true,
		],
		["the same two, where names are kept apart", ["files/Notes.txt", "files/notes.txt"], APART, false],
		["the same two, where only Unicode form folds", ["files/Notes.txt", "files/notes.txt"], UNICODE_FORM, false],
		[
			"a composed and a decomposed spelling, where Unicode form folds",
			["files/caf\u00e9", "files/cafe\u0301"],
			UNICODE_FORM,
			true,
		],
		["the same two, where only letter case folds", ["files/caf\u00e9", "files/cafe\u0301"], LETTER_CASE, false],
		[
			"a file and another file's folder differing in letter case, where case folds",
			["files/Data", "files/data/y"],
			LETTER_CASE,
			true,
		],
		["the same two, where names are kept apart", ["files/Data", "files/data/y"], APART, false],
		[
			"two paths differing in a folder's letter case, where case folds",
			["files/A/x", "files/a/x"],
			LETTER_CASE,
			true,
		],
		["a folder shared by two files, where case folds", ["files/a/x", "files/a/y"], LETTER_CASE, false],
		[
			"a backslash against a slash, where names are kept apart: a backslash is a separator on every host",
			["files/x\\y", "files/x/y"],
			APART,
			true,
		],
		["one path listed twice as written, where case folds", ["files/x", "files/x"], LETTER_CASE, false],
		[
			"a capital with a combining mark and the composed small letter, where both fold",
			[CAPITAL_WITH_MARK, SMALL_COMPOSED],
			BOTH,
			true,
		],
		["the same two, where only letter case folds", [CAPITAL_WITH_MARK, SMALL_COMPOSED], LETTER_CASE, false],
		["the same two, where only Unicode form folds", [CAPITAL_WITH_MARK, SMALL_COMPOSED], UNICODE_FORM, false],
	])("#given %s #then a clash is found: %s", (_case, paths, folding, clash) => {
		expect(oneNameUnder(paths, folding) !== undefined).toBe(clash);
	});
});

describe("refuseNamesThatFold", () => {
	const pair = ["files/Notes.txt", "files/notes.txt"];

	it("#given two paths that are one name where case folds #when the folder's file system folds case #then the bundle is refused as invalid", async () => {
		await expect(refuseNamesThatFold(pair, root, async () => LETTER_CASE)).rejects.toBeInstanceOf(
			MoveBundleInvalidError,
		);
	});

	it("#given the same two #when the folder's file system keeps them apart #then they are accepted", async () => {
		await expect(refuseNamesThatFold(pair, root, async () => APART)).resolves.toBeUndefined();
	});

	// The list is looked at before the folder is asked: that look must see every pair one folding alone makes one name.
	it("#given a capital with a combining mark and the same letter small #when the folder's file system folds only letter case #then the folder is asked and the bundle is refused", async () => {
		const probe = vi.fn(async () => LETTER_CASE);

		await expect(refuseNamesThatFold([CAPITAL_WITH_MARK, SMALL_WITH_MARK], root, probe)).rejects.toBeInstanceOf(
			MoveBundleInvalidError,
		);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("#given paths with no such pair #then the folder is never asked", async () => {
		const probe = vi.fn(async () => LETTER_CASE);

		await refuseNamesThatFold(["files/a", "files/b/c", "state/d"], root, probe);

		expect(probe).not.toHaveBeenCalled();
	});
});
