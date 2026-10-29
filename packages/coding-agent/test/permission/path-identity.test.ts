import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	containsPrefix,
	createDetector,
	createMountRewrite,
	DETECTOR_MAX_ENTRIES,
	DETECTOR_MAX_READDIR,
	mountAliasRoots,
	oracle,
	readFirmlinks,
	REAL_FS,
	volumeKeyFor,
} from "../../src/core/extensions/builtin/permission-system/alias-detector.ts";
import {
	type MountSnapshot,
	parseDarwinMountLine,
	parseLinuxMountLine,
	parseMountTable,
	readMountTable,
} from "../../src/core/extensions/builtin/permission-system/mount-table.ts";
import {
	type CanonicalPath,
	createPathIdentity,
	foldCaseText,
	identityMatches,
	PATH_IDENTITY_VERSION,
	type PathIdentity,
} from "../../src/core/extensions/builtin/permission-system/path-identity.ts";
import { Wildcard } from "../../src/core/extensions/builtin/permission-system/wildcard.ts";

const darwin = process.platform === "darwin";
const linux = process.platform === "linux";
const isRoot = process.platform !== "win32" && userInfo().uid === 0;
const here = dirname(fileURLToPath(import.meta.url));
const kernelTwinPath = resolve(here, "../../../senpi-codemode/src/kernels/shared/path-identity.mjs");

const primitives = {
	realpathNative: (value: string) => realpathSync.native(value),
	lstat: (value: string, options?: { bigint: true }) =>
		options ? lstatSync(value, { bigint: true }) : lstatSync(value, { bigint: true }),
	readlink: (value: string) => readlinkSync(value),
	pathApi: {
		join,
		dirname,
		basename,
		isAbsolute: (value: string) => value.startsWith("/"),
		sep,
		win32Resolve: win32.resolve,
	},
	platform: process.platform,
};

type Twin = { readonly name: string; readonly identity: PathIdentity; readonly version: number };

async function loadTwins(): Promise<Twin[]> {
	const host: Twin = { name: "host", identity: createPathIdentity(primitives), version: PATH_IDENTITY_VERSION };
	const module = (await import(pathToFileURL(kernelTwinPath).href)) as {
		createPathIdentity: typeof createPathIdentity;
		PATH_IDENTITY_VERSION: number;
	};
	const kernel: Twin = {
		name: "kernel",
		identity: module.createPathIdentity(primitives),
		version: module.PATH_IDENTITY_VERSION,
	};
	return [host, kernel];
}

function failureCode(fn: () => unknown): string | undefined {
	try {
		fn();
		return undefined;
	} catch (error) {
		return (error as { code?: string }).code;
	}
}

/** A fixture root that is NOT realpath'd, so a symlinked TMPDIR stays a symlinked spelling. */
function fixtureRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("path identity: equivalence table (design 5.1 + 6.1)", () => {
	let b: string;
	let real: string;
	let twins: Twin[];
	let caseInsensitive: boolean;

	beforeAll(async () => {
		b = fixtureRoot("path-identity-");
		real = realpathSync.native(b);
		mkdirSync(join(b, "real", "sub"), { recursive: true });
		writeFileSync(join(b, "real", "sub", "f"), "F");
		writeFileSync(join(b, "real", "secret2"), "S");
		writeFileSync(join(b, "secret3"), "B");
		symlinkSync(join(b, "real", "sub"), join(b, "link"));
		symlinkSync(join(b, "real", "secret2"), join(b, "flink"));
		symlinkSync(join(b, "real", "missing-target"), join(b, "dangle"));
		symlinkSync(join(b, "real", "gone", "x"), join(b, "dangle2"));
		symlinkSync(join(b, "loopb"), join(b, "loopa"));
		symlinkSync(join(b, "loopa"), join(b, "loopb"));
		writeFileSync(join(b, "caf\u00e9.txt"), "x");
		writeFileSync(join(b, "real", "na\u0308ive.txt"), "y");
		twins = await loadTwins();
		caseInsensitive = twins[0]?.identity.volumeFoldCase(real) ?? false;
	});

	afterAll(() => {
		try {
			chmodSync(join(b, "noperm"), 0o755);
		} catch {}
		rmSync(b, { recursive: true, force: true });
	});

	it("both twins carry the same PATH_IDENTITY_VERSION", async () => {
		expect(twins.map((twin) => twin.version)).toEqual([PATH_IDENTITY_VERSION, PATH_IDENTITY_VERSION]);
	});

	// raw native_climb column of design 5.1 kept as provenance: on the dangling row raw native
	// returns `<b>/dangle` while the design algorithm follows the link to `<b>/real/missing-target`.
	it.each([
		["`..` after dir link, target exists", () => `${b}/link/../secret2`, () => `${real}/real/secret2`],
		["`..` after dir link, target missing", () => `${b}/link/../secret3`, () => `${real}/real/secret3`],
		["dir symlink", () => `${b}/link/f`, () => `${real}/real/sub/f`],
		["file symlink", () => `${b}/flink`, () => `${real}/real/secret2`],
		["dangling link, target parent exists", () => `${b}/dangle`, () => `${real}/real/missing-target`],
		["missing tail 3 deep", () => `${b}/real/a/b/c`, () => `${real}/real/a/b/c`],
		["plain existing", () => `${b}/real/sub/f`, () => `${real}/real/sub/f`],
	])("%s canonicalizes identically in both twins", (_name, input, expected) => {
		for (const twin of twins) {
			expect(twin.identity.canonical(input()).path, twin.name).toBe(expected().normalize(darwin ? "NFC" : "NFKC"));
		}
	});

	it("returns on-disk case for existing components when the volume folds case", () => {
		if (!caseInsensitive) return;
		for (const twin of twins) {
			expect(twin.identity.canonical(`${b}/REAL/SUB/f`).path, twin.name).toBe(`${real}/real/sub/f`);
			expect(twin.identity.canonical(`${b}/real/sub/F`).path, twin.name).toBe(`${real}/real/sub/f`);
			expect(twin.identity.canonical(`${b}/real/sub/f`).foldCase, twin.name).toBe(true);
		}
	});

	it.skipIf(!darwin)("NFC and NFD spellings of an existing file converge to the on-disk NFC form", () => {
		for (const twin of twins) {
			expect(twin.identity.canonical(`${b}/cafe\u0301.txt`).path, twin.name).toBe(`${real}/caf\u00e9.txt`);
			expect(twin.identity.canonical(`${b}/real/n\u00e4ive.txt`).path, twin.name).toBe(
				`${real}/real/n\u00e4ive.txt`,
			);
		}
	});

	it.skipIf(!darwin)("normalizes a missing tail to NFC on darwin (H3)", () => {
		for (const twin of twins) {
			expect(twin.identity.canonical(`${b}/real/new/cafe\u0301`).path, twin.name).toBe(`${real}/real/new/caf\u00e9`);
		}
	});

	it("/tmp alias resolves to its physical directory", () => {
		if (!darwin) return;
		const alias = mkdtempSync("/tmp/path-identity-");
		try {
			writeFileSync(join(alias, "t"), "T");
			for (const twin of twins) {
				expect(twin.identity.canonical(`${alias}/t`).path, twin.name).toBe(`/private${alias}/t`);
			}
		} finally {
			rmSync(alias, { recursive: true, force: true });
		}
	});

	it.each([
		["ELOOP", () => `${b}/loopa/x`, "ELOOP"],
		["EDANGLING (link target's parent missing)", () => `${b}/dangle2`, "EDANGLING"],
	])("%s is unresolvable with its own code", (_name, input, code) => {
		for (const twin of twins)
			expect(
				failureCode(() => twin.identity.canonical(input())),
				twin.name,
			).toBe(code);
	});

	it.skipIf(isRoot)("EACCES on a parent is unresolvable, not tolerated as missing (M2)", () => {
		mkdirSync(join(b, "noperm", "in"), { recursive: true });
		chmodSync(join(b, "noperm"), 0o000);
		try {
			for (const twin of twins) {
				expect(
					failureCode(() => twin.identity.canonical(`${b}/noperm/in/g`)),
					twin.name,
				).toBe("EACCES");
			}
		} finally {
			chmodSync(join(b, "noperm"), 0o755);
		}
	});

	it("joins a missing tail onto the root without a doubled separator (L4)", () => {
		for (const twin of twins) {
			expect(twin.identity.canonical("/no-such-entry-for-path-identity/x").path, twin.name).toBe(
				"/no-such-entry-for-path-identity/x",
			);
		}
	});

	it("a relative executed path needs a cwd and is anchored to it without lexical `..` collapse", () => {
		for (const twin of twins) {
			expect(
				failureCode(() => twin.identity.canonical("relative/x")),
				twin.name,
			).toBe("ERELATIVE");
			expect(twin.identity.canonical("link/../secret2", b).path, twin.name).toBe(`${real}/real/secret2`);
		}
	});

	it("folds case per code point only where the lowercase form is one code point (L2)", () => {
		expect(foldCaseText("\u0130")).toBe("\u0130");
		expect(foldCaseText("ABC\u1E9E")).toBe("abc\u00df".length === 4 ? "abc\u00df" : foldCaseText("ABC\u1E9E"));
		expect(foldCaseText("ABC")).toBe("abc");
	});

	it("probes the volume once per device and caches the answer (N12)", () => {
		let probes = 0;
		const counting = createPathIdentity({
			...primitives,
			lstat: (value, options) => {
				probes += 1;
				return primitives.lstat(value, options);
			},
		});
		const first = counting.volumeFoldCase(real);
		const after = probes;
		expect(counting.volumeFoldCase(real)).toBe(first);
		expect(probes).toBe(after + 1);
	});

	it("splits a rule at its first wildcard backed to the previous separator (6.1.5)", () => {
		for (const twin of twins) {
			expect(twin.identity.canonicalRule("*")).toBeUndefined();
			expect(twin.identity.canonicalRule(`${b}/link/*.env`)).toMatchObject({
				prefix: `${real}/real/sub`,
				suffix: "/*.env",
				wildcardOnly: false,
			});
			expect(twin.identity.canonicalRule(`${b}/flink`)).toMatchObject({
				prefix: `${real}/real/secret2`,
				suffix: "",
			});
			expect(twin.identity.canonicalRule("*.env")).toMatchObject({
				prefix: undefined,
				wildcardOnly: true,
				suffix: "*.env",
			});
			expect(twin.identity.canonicalRule("src/*.env", b)).toMatchObject({ prefix: `${real}/src`, suffix: "/*.env" });
		}
	});

	it("matches canonical forms by prefix and folded suffix", () => {
		const identity = twins[0]?.identity;
		if (!identity) throw new Error("no twin");
		const rule = identity.canonicalRule(`${b}/link/*.env`);
		if (!rule) throw new Error("rule");
		const match = (value: CanonicalPath) => identityMatches(rule, value, Wildcard.match, sep);
		expect(match({ path: `${real}/real/sub/a.env`, foldCase: false })).toBe(true);
		expect(match({ path: `${real}/real/sub/A.ENV`, foldCase: true })).toBe(true);
		expect(match({ path: `${real}/real/sub/A.ENV`, foldCase: false })).toBe(false);
		expect(match({ path: `${real}/real/subx/a.env`, foldCase: false })).toBe(false);
		const exact = identity.canonicalRule(`${b}/flink`);
		if (!exact) throw new Error("exact");
		expect(identityMatches(exact, { path: `${real}/real/secret2`, foldCase: false }, Wildcard.match, sep)).toBe(true);
		expect(identityMatches(exact, { path: `${real}/real/secret2/x`, foldCase: false }, Wildcard.match, sep)).toBe(
			false,
		);
		const only = identity.canonicalRule("*.env");
		if (!only) throw new Error("only");
		expect(identityMatches(only, { path: `${real}/x/.env`, foldCase: false }, Wildcard.match, sep)).toBe(true);
	});

	it("the Python contract sends no kernel canonical: the host route canonicalizes a relative path with its cwd", () => {
		// posixpath.realpath is walker-class (design 5.3 rows differ from native on case and NFC/NFD), so a
		// Python cell never ships a canonical; the host anchors `path` to the cell cwd and resolves it here.
		for (const twin of twins) {
			expect(twin.identity.canonical("flink", b).path, twin.name).toBe(`${real}/real/secret2`);
		}
	});
});

describe("alias detector: mount table parser (design 5.5, R7-M1)", () => {
	it.each([
		["/dev/disk9s1 on /Volumes/My (Disk) (apfs, local, nodev)", { on: "/Volumes/My (Disk)", type: "apfs" }],
		["/dev/disk9s3 on /Volumes/a on b (exfat, local)", { on: "/Volumes/a on b", type: "exfat" }],
		["/dev/disk9s2 on /Volumes/Plain (smbfs, nodev)", { on: "/Volumes/Plain", type: "smbfs" }],
		[
			"/dev/disk9s4 on /Volumes/Backup (2024) (apfs, local, journaled)",
			{ on: "/Volumes/Backup (2024)", type: "apfs" },
		],
		[
			"/dev/disk9s5 on /Volumes/Sauvegarde \u00e9t\u00e9 (apfs, local)",
			{ on: "/Volumes/Sauvegarde \u00e9t\u00e9", type: "apfs" },
		],
		[
			"map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
			{ on: "/System/Volumes/Data/home", type: "autofs" },
		],
		["/dev/disk9s6 on /Volumes/X (apfs, local) (msdos, local)", { on: "/Volumes/X (apfs, local)", type: "msdos" }],
	])("parses %j", (line, want) => {
		expect(parseDarwinMountLine(line)).toMatchObject(want);
	});

	it.each([
		"garbage line without parenthetical",
		"/dev/x on relative/path (apfs)",
		"/dev/x on /Volumes/Y (Disk) (apfs",
		"on /Volumes/Z (apfs)",
		"/dev/x on /Volumes/Z (ap fs, local)",
		"/dev/x on /Volumes/Z ()",
		"/dev/x on /Volumes//Z (apfs)",
		"/dev/x on /Volumes/Z/ (apfs)",
		"/dev/x on /Volumes/Z (apfs, local (nested))",
	])("rejects %j", (line) => {
		expect(parseDarwinMountLine(line)).toBeUndefined();
	});

	it("decodes linux octal escapes and validates fields", () => {
		expect(parseLinuxMountLine("/dev/sda1 /mnt/with\\040space ext4 rw 0 0")).toEqual({
			dev: "/dev/sda1",
			on: "/mnt/with space",
			type: "ext4",
		});
		expect(parseLinuxMountLine("overlay / overlay rw 0 0")).toMatchObject({ on: "/", type: "overlay" });
		expect(parseLinuxMountLine("x relative ext4")).toBeUndefined();
		expect(parseLinuxMountLine("too-few")).toBeUndefined();
	});

	it("flags a snapshot with a broken line or no root as degraded; a repeated darwin mount point is ambiguous", () => {
		expect(parseMountTable("/dev/disk1 on / (apfs, local)\nbroken line", "darwin").degraded).toBe(true);
		const repeated = parseMountTable("/dev/disk1 on / (apfs, local)\n/dev/disk2 on / (apfs, local)", "darwin");
		expect(repeated).toMatchObject({ degraded: false, ambiguous: ["/"] });
		expect(parseMountTable("/dev/disk1 on /Volumes/X (apfs, local)", "darwin").degraded).toBe(true);
		const good = parseMountTable("/dev/disk1 on / (apfs, local)\n/dev/disk2 on /Volumes/X (apfs, local)", "darwin");
		expect(good).toMatchObject({ degraded: false, ambiguous: [] });
		expect(good.mounts.map((mount) => mount.on)).toEqual(["/Volumes/X", "/"]);
	});

	it("a degraded snapshot confirms nothing: every path is alias and keys to unknown", () => {
		const degraded = parseMountTable("/dev/disk1 on / (apfs, local)\nbroken line", "darwin");
		const verdict = createDetector(degraded)(join(homedir(), ".zshrc"));
		expect(verdict.alias).toBe(true);
		expect(verdict.reasons).toContain("mount-snapshot-degraded");
		expect(volumeKeyFor(degraded, (value) => value, join(homedir(), "x"))).toBe("unknown");
		expect(volumeKeyFor(undefined, (value) => value, "/x")).toBe("unknown");
	});

	it("keys the breaker lexically by the longest mount point after the firmlink rewrite (5.5)", () => {
		const snapshot = parseMountTable(
			[
				"/dev/disk1s1 on / (apfs, sealed, local, read-only, journaled)",
				"/dev/disk1s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
				"map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
			].join("\n"),
			"darwin",
		);
		const rewrite = createMountRewrite(["/Users", "/private", "/home", "/tmp"]);
		expect(volumeKeyFor(snapshot, rewrite, "/Users/me/x")).toBe("/System/Volumes/Data");
		expect(volumeKeyFor(snapshot, rewrite, "/home/x")).toBe("/System/Volumes/Data/home");
		expect(volumeKeyFor(snapshot, rewrite, "/usr/bin/x")).toBe("/");
		expect(volumeKeyFor(snapshot, rewrite, "/System/Volumes/Data/private/tmp/x")).toBe("/System/Volumes/Data");
	});

	it("the allowlist is exactly the measured set (R7-L1)", () => {
		expect([...REAL_FS].sort()).toEqual(["apfs", "btrfs", "nfs", "overlay", "tmpfs", "virtiofs"]);
	});

	it.each(["alias-detector.ts", "mount-table.ts"])(
		"importing %s performs no filesystem side effect (R7-L2)",
		(file) => {
			const source = readFileSync(
				resolve(here, "../../src/core/extensions/builtin/permission-system", file),
				"utf8",
			);
			const topLevel = source
				.split("\n")
				.filter((line) => /^(const|let|var) .*=.*\(/.test(line) && !/^(const|let|var) \w+ = \//.test(line));
			expect(topLevel.filter((line) => /Sync\(|spawn|readMountTable\(/.test(line))).toEqual([]);
		},
	);

	it.skipIf(!linux)("the runner's own mount table is not degraded (R8-L1)", () => {
		const snapshot = parseMountTable(readFileSync("/proc/self/mounts", "utf8"), "linux");
		if (snapshot.degraded) console.log(`rejected: ${JSON.stringify(snapshot.rejected)}`);
		expect(snapshot.degraded).toBe(false);
	});

	it.skipIf(!darwin)("the live mount table on this host parses with zero rejected lines", () => {
		const snapshot = readMountTable();
		expect(snapshot.rejected).toEqual([]);
		expect(snapshot.degraded).toBe(false);
		expect(mountAliasRoots(snapshot)).toContain("/System/Volumes/Data");
	});
});

type Row = readonly [name: string, path: string, expectFalsePositive?: boolean];

function runRows(detector: (value: string) => ReturnType<ReturnType<typeof createDetector>>, rows: readonly Row[]) {
	const results = rows.map(([name, path, allowedFalsePositive]) => {
		let nativeAlias: boolean;
		try {
			nativeAlias = oracle(path) !== path;
		} catch {
			nativeAlias = true;
		}
		const verdict = detector(path);
		return {
			name,
			nativeAlias,
			alias: verdict.alias,
			reasons: verdict.reasons,
			falseNegative: nativeAlias && !verdict.alias,
			falsePositive: !nativeAlias && verdict.alias && !allowedFalsePositive,
		};
	});
	return results;
}

describe("alias detector: zero false negatives against native (design 5.4, 11.1.1b)", () => {
	let b: string;
	let tmpAlias: string | undefined;
	let fd = -1;
	let snapshot: MountSnapshot;
	let detector: ReturnType<typeof createDetector>;

	beforeAll(() => {
		b = fixtureRoot("alias-detector-");
		snapshot = readMountTable();
		detector = createDetector(snapshot);
		mkdirSync(join(b, "real", "sub"), { recursive: true });
		mkdirSync(join(b, "real", "Upper"));
		writeFileSync(join(b, "real", "sub", "f"), "F");
		writeFileSync(join(b, "real", "secret2"), "TOP-SECRET-CONTENT");
		writeFileSync(join(b, "secret3"), "B");
		writeFileSync(join(b, "real", "Upper", "Mixed.TXT"), "M");
		symlinkSync(join(b, "real", "sub"), join(b, "link"));
		symlinkSync(join(b, "real", "secret2"), join(b, "flink"));
		linkSync(join(b, "real", "secret2"), join(b, "real", "hardalias"));
		writeFileSync(join(b, "caf\u00e9.txt"), "x");
		writeFileSync(join(b, "real", "na\u0308ive.txt"), "y");
		symlinkSync(join(b, "real", "missing-target"), join(b, "dangle"));
		symlinkSync(join(b, "real", "gone", "x"), join(b, "dangle2"));
		symlinkSync(join(b, "loopb"), join(b, "loopa"));
		symlinkSync(join(b, "loopa"), join(b, "loopb"));
		mkdirSync(join(b, "noperm", "in"), { recursive: true });
		if (!isRoot) chmodSync(join(b, "noperm"), 0o000);
		if (darwin) {
			symlinkSync(`/System/Volumes/Data${homedir()}`, join(b, "into-data-home"));
			tmpAlias = `/tmp/alias-detector-${process.pid}`;
			mkdirSync(tmpAlias, { recursive: true });
			writeFileSync(join(tmpAlias, "t"), "T");
		}
		fd = openSync(join(b, "real", "secret2"), "r");
	});

	afterAll(() => {
		if (fd >= 0) closeSync(fd);
		try {
			chmodSync(join(b, "noperm"), 0o755);
		} catch {}
		rmSync(b, { recursive: true, force: true });
		if (tmpAlias) rmSync(tmpAlias, { recursive: true, force: true });
	});

	it("never answers no-alias where native canonicalizes to a different string", () => {
		const rows: Row[] = [
			["plain real path (control)", `${b}/real/sub/f`],
			["plain missing tail (control)", `${b}/real/new/file`],
			["dotdot after dir link, exists", `${b}/link/../secret2`],
			["dotdot after dir link, missing", `${b}/link/../secret3`],
			["plain dotdot", `${b}/real/sub/../secret2`],
			["dir symlink", `${b}/link/f`],
			["file symlink", `${b}/flink`],
			["case: dir components", `${b}/REAL/SUB/f`],
			["case: file component", `${b}/real/sub/F`],
			["case: on-disk Upper, lowercase request", `${b}/real/upper/mixed.txt`],
			["NFC file, NFD request", `${b}/cafe\u0301.txt`],
			["NFD file, NFC request", `${b}/real/n\u00e4ive.txt`],
			["dangling link", `${b}/dangle`],
			["dangling, parent missing", `${b}/dangle2`],
			["symlink loop", `${b}/loopa/x`],
			...(isRoot ? [] : [["EACCES parent", `${b}/noperm/in/g`] as Row]),
			["trailing slash", `${b}/real/sub/`],
			["double slash", `${b}/real//sub/f`],
			["hard link (native: itself)", `${b}/real/hardalias`],
		];
		if (darwin) {
			const home = homedir();
			const D = "/System/Volumes/Data";
			const st = statSync(join(b, "real", "secret2"), { bigint: true });
			// Bun's native realpath collapses firmlinks, volfs and devfs spellings; Node's (libuv) keeps them.
			// Where the running native keeps them, the detector's alias verdict is a false positive in the
			// allowed direction (latency only), never a false negative.
			const keeps = realpathSync.native(`${D}/private/tmp`) === `${D}/private/tmp`;
			const bootLink = readdirSync("/Volumes").find((name) => {
				try {
					return lstatSync(`/Volumes/${name}`).isSymbolicLink();
				} catch {
					return false;
				}
			});
			rows.push(
				["/tmp alias", `${tmpAlias}/t`],
				["case: /TMP", "/TMP"],
				["FIRMLINK: Data spelling of HOME file", `${D}${home}/.zshrc`, keeps],
				["FIRMLINK: Data spelling of /private/tmp", `${D}/private/tmp`, keeps],
				["FIRMLINK: canonical HOME spelling (control)", `${home}/.zshrc`],
				["FIRMLINK: Data volume root (allowed false positive)", D, true],
				["ATTACK: uppercase prefix", "/SYSTEM/VOLUMES/DATA/Users"],
				["ATTACK: lowercase component", "/System/Volumes/data/Users"],
				["ATTACK: double slash", "//System/Volumes/Data/Users"],
				["ATTACK: symlink into Data spelling of HOME", `${b}/into-data-home/.zshrc`, keeps],
				["/var symlink", "/var/tmp"],
				...(bootLink ? [[`/Volumes/<boot> -> /`, `/Volumes/${bootLink}/Users`] as Row] : []),
				["VOLFS /.vol/<dev>/<ino> of the secret", `/.vol/${st.dev}/${st.ino}`, keeps],
				["DEVFS /dev/fd/<n> open on the secret", `/dev/fd/${fd}`, keeps],
				["DEVFS /dev/stdin", "/dev/stdin", keeps],
				["DEVFS /dev/null (allowed false positive)", "/dev/null", true],
				["/System/Volumes/Preboot (separate volume root)", "/System/Volumes/Preboot"],
				["/home (autofs trigger)", "/home"],
				["/.vol root itself", "/.vol"],
			);
		}
		const results = runRows(detector, rows);
		const falseNegatives = results.filter((result) => result.falseNegative);
		const falsePositives = results.filter((result) => result.falsePositive);
		expect(falseNegatives, JSON.stringify(falseNegatives)).toEqual([]);
		expect(falsePositives, JSON.stringify(falsePositives)).toEqual([]);
		expect(
			results.find((result) => result.name.startsWith("VOLFS"))?.reasons.join(",") ?? "phantom-parent",
		).toContain("phantom-parent");
		expect(
			results.find((result) => result.name.startsWith("DEVFS /dev/fd"))?.reasons.join(",") ?? "fs-type:devfs",
		).toContain("fs-type:devfs");
	});

	it("reaches(): a rule's walked prefix contains the request after the mount rewrite and fold (6.5.1)", () => {
		const rewrite = createMountRewrite(darwin ? readFirmlinks() : []);
		const real = realpathSync.native(b);
		expect(containsPrefix(`${b}/link`, `${real}/real/sub/f`, rewrite, true)).toBe(true);
		expect(containsPrefix(`${b}/real/sub`, `${real}/real/other`, rewrite, true)).toBe(false);
		expect(containsPrefix(`${b}/REAL/SUB`, `${real}/real/sub/f`, rewrite, true)).toBe(true);
		expect(containsPrefix(`${b}/REAL/SUB`, `${real}/real/sub/f`, rewrite, false)).toBe(false);
		expect(containsPrefix(`${b}/loopa`, `${real}/anything`, rewrite, true)).toBe(true);
		if (darwin) {
			const home = homedir();
			expect(containsPrefix(`/System/Volumes/Data${home}`, `${home}/x`, rewrite, true)).toBe(true);
			expect(containsPrefix(home, `/System/Volumes/Data${home}/x`, rewrite, true)).toBe(true);
		}
	});

	it("budget: more than DETECTOR_MAX_READDIR readdirs or a directory over DETECTOR_MAX_ENTRIES is alias", () => {
		const good = parseMountTable("/dev/disk1 on / (apfs, local)", "darwin");
		const components = Array.from({ length: DETECTOR_MAX_READDIR + 10 }, (_, index) => `d${index}`);
		const deep = `/${components.join("/")}`;
		const io = {
			walk: (value: string) => value,
			readdir: (value: string) => {
				const depth = value === "/" ? 0 : value.split("/").length - 1;
				return [`d${depth}`];
			},
			lstat: () => ({}),
		};
		const over = createDetector(good, undefined, io, "darwin")(deep);
		expect(over.alias).toBe(true);
		expect(over.reasons.join(",")).toContain("readdir:EBUDGET");
		const wide = createDetector(
			good,
			undefined,
			{ ...io, readdir: () => Array.from({ length: DETECTOR_MAX_ENTRIES + 1 }, (_, index) => `e${index}`) },
			"darwin",
		)("/e0/e1");
		expect(wide.alias).toBe(true);
		expect(wide.reasons.join(",")).toContain("EBUDGET-entries");
		const shallow = `/${components.slice(0, 25).join("/")}`;
		expect(createDetector(good, undefined, io, "darwin")(shallow)).toMatchObject({ alias: false, readdirs: 25 });
	});

	it("real working paths: zero false positives and bounded latency (5.6 regression guard)", () => {
		const sample = (root: string, depth: number, limit: number): string[] => {
			const out: string[] = [];
			const walk = (directory: string, level: number) => {
				if (out.length >= limit || level > depth) return;
				let entries: string[];
				try {
					entries = readdirSync(directory);
				} catch {
					return;
				}
				for (const entry of entries) {
					if (out.length >= limit) return;
					if (entry === ".git") continue;
					const path = join(directory, entry);
					try {
						if (lstatSync(path).isSymbolicLink()) continue;
					} catch {
						continue;
					}
					out.push(path);
					try {
						if (statSync(path).isDirectory()) walk(path, level + 1);
					} catch {}
				}
			};
			walk(root, 1);
			return out;
		};
		const repo = resolve(here, "../..");
		const sets: [string, string[]][] = [
			["$HOME", sample(homedir(), 2, 150)],
			["repo", sample(repo, 4, 300)],
			["node_modules", sample(resolve(repo, "../../node_modules"), 4, 300)],
			["$TMPDIR", sample(tmpdir(), 2, 100)],
			...(darwin ? [["/private/tmp", sample("/private/tmp", 1, 50)] as [string, string[]]] : []),
		];
		for (const [name, paths] of sets) {
			const durations: number[] = [];
			const falsePositives: string[] = [];
			for (const path of paths) {
				let nativeAlias = true;
				try {
					nativeAlias = oracle(path) !== path;
				} catch {}
				const started = performance.now();
				const verdict = detector(path);
				durations.push(performance.now() - started);
				if (!nativeAlias && verdict.alias) falsePositives.push(`${path} [${verdict.reasons.join(",")}]`);
			}
			durations.sort((a, b) => a - b);
			const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
			expect(falsePositives, `${name}: ${falsePositives.slice(0, 5).join("; ")}`).toEqual([]);
			// 5.6 measured p95 <= 10 ms on an idle host and 14-24 ms on a loaded shared runner; 100 ms is about 4x the
			// worst loaded measurement, so a real regression fails here (p95 is printed so a drift stays visible).
			console.log(`detector ${name}: n=${durations.length} p95=${p95.toFixed(2)}ms`);
			expect(p95, `${name} p95`).toBeLessThan(100);
		}
	}, 60_000);

	it.skipIf(!linux)("linux rows: overlay/tmpfs/proc spellings never confirm an alias away", () => {
		const rows: Row[] = [
			["overlay file (control)", "/usr/bin/env"],
			["missing tail (control)", `${b}/real/new/file`],
			["/proc/self/root spelling", `/proc/self/root${b}/real/sub/f`],
			["/proc/self/cwd relative", "/proc/self/cwd/x"],
			["/proc/self/fd/0", "/proc/self/fd/0"],
			["/dev/stdin", "/dev/stdin"],
			["dotdot via symlink", `${b}/link/../secret2`],
		];
		const results = runRows(detector, rows);
		expect(results.filter((result) => result.falseNegative)).toEqual([]);
	});
});

describe.skipIf(!darwin)("alias detector: attached volumes (case-sensitive APFS and awkward mount names)", () => {
	const scratch = fixtureRoot("alias-volumes-");
	const images: { name: string; dmg: string; mountPoint: string | undefined; fs: string }[] = [];
	const hasHdiutil = spawnSync("which", ["hdiutil"]).status === 0;

	const attach = (name: string, fs: string): string | undefined => {
		const dmg = join(scratch, `vol-${process.pid}-${images.length}.dmg`);
		let mountPoint: string | undefined;
		if (hasHdiutil) {
			const created = spawnSync("hdiutil", ["create", "-quiet", "-size", "32m", "-fs", fs, "-volname", name, dmg]);
			if (created.status === 0) {
				const attached = spawnSync("hdiutil", ["attach", "-nobrowse", dmg], { encoding: "utf8" });
				const point = attached.stdout
					.trim()
					.split("\n")
					.map((line) => line.split(/\t+/).at(-1))
					.find((entry) => entry?.startsWith("/Volumes/"));
				if (attached.status === 0 && point && existsSync(point)) mountPoint = point;
			}
		}
		images.push({ name, dmg, mountPoint, fs });
		if (!mountPoint) {
			console.log(
				`SKIP volume rows for ${JSON.stringify(name)}: ${hasHdiutil ? "image could not be created or attached" : "hdiutil unavailable"}`,
			);
		}
		return mountPoint;
	};

	afterAll(() => {
		for (const image of images) {
			if (image.mountPoint) spawnSync("hdiutil", ["detach", "-quiet", image.mountPoint]);
			rmSync(image.dmg, { force: true });
		}
		rmSync(scratch, { recursive: true, force: true });
		expect(images.every((image) => !image.mountPoint || !existsSync(image.mountPoint))).toBe(true);
	}, 120_000);

	it("each volume confirms through its OWN mount entry; case and NFC variants are not enumerable", (context) => {
		const cs = attach(`senpi-csapfs-${process.pid}`, "Case-sensitive APFS");
		const paren = attach(`Backup (2024) ${process.pid}`, "APFS");
		const onName = attach(`Log on Disk ${process.pid}`, "APFS");
		const unicode = attach(`Sauvegarde \u00e9t\u00e9 ${process.pid}`, "APFS");
		if (!cs && !paren && !onName && !unicode) {
			context.skip();
			return;
		}
		const snapshot = readMountTable();
		expect(snapshot.degraded).toBe(false);
		const detector = createDetector(snapshot);
		const rows: Row[] = [];
		for (const image of images) {
			if (!image.mountPoint) continue;
			expect(snapshot.mounts.find((mount) => mount.on === image.mountPoint)?.type).toBe("apfs");
			mkdirSync(join(image.mountPoint, "Real", "sub"), { recursive: true });
			writeFileSync(join(image.mountPoint, "Real", "sub", "f"), "F");
			if (image.fs.startsWith("Case")) writeFileSync(join(image.mountPoint, "Real", "sub", "F"), "F2");
		}
		if (cs) {
			rows.push(
				["CS-APFS: exact spelling (control)", `${cs}/Real/sub/f`],
				["CS-APFS: other-case file exists separately", `${cs}/Real/sub/F`],
				["CS-APFS: wrong-case dir (missing)", `${cs}/real/sub/f`],
				["CS-APFS via lowercase /volumes prefix", `${cs.replace("/Volumes/", "/volumes/")}/Real/sub/f`],
			);
		}
		if (paren)
			rows.push(
				["MOUNT NAME ' (': file (control)", `${paren}/Real/sub/f`],
				["MOUNT NAME ' (': case variant", `${paren}/real/sub/f`],
			);
		if (onName)
			rows.push(
				["MOUNT NAME ' on ': file (control)", `${onName}/Real/sub/f`],
				["MOUNT NAME ' on ': case variant", `${onName}/real/sub/f`],
			);
		if (unicode) {
			rows.push(
				["MOUNT NAME Unicode: as attached (control)", `${unicode}/Real/sub/f`],
				["MOUNT NAME Unicode: NFD spelling", `${unicode.normalize("NFD")}/Real/sub/f`],
				["MOUNT NAME Unicode: NFC spelling", `${unicode.normalize("NFC")}/Real/sub/f`],
			);
		}
		const results = runRows(detector, rows);
		expect(results.filter((result) => result.falseNegative)).toEqual([]);
		expect(results.filter((result) => result.falsePositive)).toEqual([]);
		for (const result of results) {
			if (result.name.includes("case variant") || result.name.includes("lowercase /volumes")) {
				expect(result.reasons.join(","), result.name).toContain("not-enumerable");
			}
		}
	}, 120_000);
});
