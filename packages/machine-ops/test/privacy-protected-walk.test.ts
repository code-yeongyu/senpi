import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { localGlob } from "../src/files/glob.ts";
import { localGrep } from "../src/files/grep.ts";
import { privacyProtectedDirs, walkGuard } from "../src/files/privacy-protected.ts";

// omo#15240: a search from the home directory read ~/Music, ~/Downloads, ~/Library and volume roots, and macOS raised a
// privacy prompt for each on the searching process's behalf. A walk never enters a protected folder it did not start in.
const dirs: string[] = [];
const savedPath = process.env.PATH;
afterEach(async () => {
	process.env.PATH = savedPath;
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fdPath = (() => {
	try {
		return execFileSync("sh", ["-c", "command -v fd || command -v fdfind"], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
})();

/** A fake macOS home: protected folders at its top, plus a project that has its own folder named Music. */
async function fakeHome(at?: string): Promise<string> {
	const home = at ?? (await realpath(await mkdtemp(join(tmpdir(), "privacy-walk-home-"))));
	if (at === undefined) dirs.push(home);
	for (const rel of ["Music/Music", "Downloads", "Library/Mobile Documents", "Pictures", "code/Music"]) {
		await mkdir(join(home, rel), { recursive: true });
	}
	await writeFile(join(home, "Music", "Music", "library.txt"), "needle\n");
	await writeFile(join(home, "Downloads", "file.txt"), "needle\n");
	await writeFile(join(home, "Library", "Mobile Documents", "doc.txt"), "needle\n");
	await writeFile(join(home, "Pictures", "photo.txt"), "needle\n");
	await writeFile(join(home, "code", "notes.txt"), "needle\n");
	await writeFile(join(home, "code", "Music", "track.txt"), "needle\n");
	return home;
}

const signal = () => new AbortController().signal;
const reachable = (home: string) => [join(home, "code", "Music", "track.txt"), join(home, "code", "notes.txt")];

describe("privacyProtectedDirs", () => {
	it("names the macOS home folders and volume roots, and nothing elsewhere", () => {
		const darwin = privacyProtectedDirs("darwin", "/Users/u");
		for (const dir of ["/Users/u/Music", "/Users/u/Downloads", "/Users/u/Library", "/Volumes", "/Network"]) {
			assert.ok(darwin.paths.includes(dir), dir);
		}
		assert.deepEqual(privacyProtectedDirs("linux", "/home/u").paths, []);
	});
});

// On macOS the data volume is also mounted at /System/Volumes/Data, so /System/Volumes/Data/Users/<me>/Desktop is the
// same TCC-protected folder as ~/Desktop. A walk started at or under /System/Volumes must still skip it.
describe("a search from the data volume's /System/Volumes spelling on macOS", () => {
	const home = "/Users/someone";
	for (const root of ["/System/Volumes", "/System/Volumes/Data", "/System/Volumes/Data/Users"]) {
		it(`started at ${root} skips the home folders spelled through the data volume`, () => {
			const guard = walkGuard(root, privacyProtectedDirs("darwin", home));
			for (const folder of ["Desktop", "Documents", "Downloads", "Library", "Music", "Pictures", "Movies"])
				assert.equal(guard.skips(join("/System/Volumes/Data", home, folder)), true, folder);
			assert.ok(guard.excluded.length >= 7);
		});
	}
	it("a walk started inside a data-volume spelled protected folder is an explicit ask and reads it", () => {
		const guard = walkGuard(join("/System/Volumes/Data", home, "Music"), privacyProtectedDirs("darwin", home));
		assert.deepEqual(guard.excluded, []);
	});
});

describe("a search from the home directory on macOS", () => {
	it("grep never reads a protected folder", async () => {
		const home = await fakeHome();
		const result = await localGrep(
			home,
			"needle",
			undefined,
			1 << 20,
			signal(),
			privacyProtectedDirs("darwin", home),
		);
		assert.deepEqual(result.matches.map((match) => match.path).sort(), reachable(home));
	});

	it("the walking glob never enters a protected folder", async () => {
		const home = await fakeHome();
		process.env.PATH = await mkdtemp(join(tmpdir(), "privacy-walk-no-fd-"));
		dirs.push(process.env.PATH);
		const result = await localGlob(
			"*.txt",
			home,
			undefined,
			signal(),
			undefined,
			privacyProtectedDirs("darwin", home),
		);
		assert.deepEqual(result.entries.map((entry) => entry.path).sort(), reachable(home));
	});

	it.skipIf(fdPath === undefined)("the fd glob never enters a protected folder", async () => {
		const home = await fakeHome();
		const resolveFd = async () => fdPath;
		const result = await localGlob(
			"*.txt",
			home,
			undefined,
			signal(),
			resolveFd,
			privacyProtectedDirs("darwin", home),
		);
		assert.deepEqual(result.entries.map((entry) => entry.path).sort(), reachable(home));
	});

	it("a search started inside a protected folder is an explicit ask and reads it", async () => {
		const home = await fakeHome();
		const music = join(home, "Music");
		const protectedDirs = privacyProtectedDirs("darwin", home);
		const grep = await localGrep(music, "needle", undefined, 1 << 20, signal(), protectedDirs);
		assert.deepEqual(
			grep.matches.map((match) => match.path),
			[join(music, "Music", "library.txt")],
		);
		const glob = await localGlob("*.txt", music, undefined, signal(), undefined, protectedDirs);
		assert.deepEqual(
			glob.entries.map((entry) => entry.path),
			[join(music, "Music", "library.txt")],
		);
	});
});

type Walk = (root: string, home: string) => Promise<string[]>;
const walks: ReadonlyArray<readonly [string, Walk | undefined]> = [
	[
		"grep",
		async (root, home) =>
			(await localGrep(root, "needle", undefined, 1 << 20, signal(), privacyProtectedDirs("darwin", home))).matches
				.map((match) => match.path)
				.sort(),
	],
	[
		"the walking glob",
		async (root, home) => {
			process.env.PATH = await mkdtemp(join(tmpdir(), "privacy-walk-no-fd-"));
			dirs.push(process.env.PATH);
			const result = await localGlob(
				"*.txt",
				root,
				undefined,
				signal(),
				undefined,
				privacyProtectedDirs("darwin", home),
			);
			return result.entries.map((entry) => entry.path).sort();
		},
	],
	[
		"the fd glob",
		fdPath === undefined
			? undefined
			: async (root, home) => {
					const result = await localGlob(
						"*.txt",
						root,
						undefined,
						signal(),
						async () => fdPath,
						privacyProtectedDirs("darwin", home),
					);
					return result.entries.map((entry) => entry.path).sort();
				},
	],
];

// The walk start and HOME are compared as the folders they name, not as text: a symlinked alias of either, or a HOME
// spelled in another case than the disk (macOS volumes ignore case), still keeps every walk out of the protected folders.
describe.each(walks)("%s reaching the home directory another way", (_name, walk) => {
	it.skipIf(walk === undefined)("started from a symlink to the home directory", async () => {
		const home = await fakeHome();
		const alias = `${home}-alias`;
		await symlink(home, alias, "dir");
		dirs.push(alias);
		assert.deepEqual(await walk?.(alias, home), reachable(alias));
	});

	it.skipIf(walk === undefined)("with HOME naming the home directory through a symlink", async () => {
		const home = await fakeHome();
		const alias = `${home}-alias`;
		await symlink(home, alias, "dir");
		dirs.push(alias);
		assert.deepEqual(await walk?.(home, alias), reachable(home));
	});

	it.skipIf(walk === undefined)("started above a home directory HOME spells in another case", async () => {
		const parent = await realpath(await mkdtemp(join(tmpdir(), "privacy-walk-parent-")));
		dirs.push(parent);
		const home = await fakeHome(join(parent, "Home"));
		assert.deepEqual(await walk?.(parent, join(parent, "HOME")), reachable(home));
	});
});
