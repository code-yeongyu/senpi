import { describe, expect, it } from "vitest";
import {
	createDetector,
	type DetectorIO,
	volumeKeyFor,
} from "../../src/core/extensions/builtin/permission-system/alias-detector.ts";
import { parseMountTable } from "../../src/core/extensions/builtin/permission-system/mount-table.ts";

// A systemd host's /proc/self/mounts, trimmed: binfmt_misc is stacked on the autofs trigger at the
// same mount point, and /run is listed twice because a later tmpfs was mounted over the first one.
const LINUX_STACKED = [
	"/dev/sda1 / ext4 rw,relatime 0 0",
	"proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
	"tmpfs /run tmpfs rw,nosuid,nodev,size=1024k 0 0",
	"systemd-1 /proc/sys/fs/binfmt_misc autofs rw,relatime,fd=30 0 0",
	"binfmt_misc /proc/sys/fs/binfmt_misc binfmt_misc rw,nosuid,nodev,noexec,relatime 0 0",
	"tmpfs /run tmpfs rw,nosuid,nodev,size=4096k 0 0",
	"tmpfs /run/user/1000 tmpfs rw,nosuid,nodev,relatime 0 0",
].join("\n");

const DARWIN_REPEATED = [
	"/dev/disk1s1 on / (apfs, sealed, local, read-only, journaled)",
	"/dev/disk2s1 on /Volumes/X (apfs, local, journaled)",
	"/dev/disk3s1 on /Volumes/X (apfs, local, journaled)",
	"/dev/disk4s1 on /Volumes/Y (apfs, local, journaled)",
].join("\n");

/** A fully enumerable synthetic tree: every component listed by its parent, nothing is a link. */
function enumerable(tree: Record<string, string[]>): DetectorIO {
	return {
		walk: (value) => value,
		readdir: (value) => {
			const entries = tree[value];
			if (!entries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return entries;
		},
		lstat: () => ({}),
	};
}

const budget = { maxReaddir: 64, maxEntries: 64 };

describe("mount table: a mount point listed more than once", () => {
	it("keeps the last line for a linux mount point and does not degrade the snapshot", () => {
		const snapshot = parseMountTable(LINUX_STACKED, "linux");
		expect(snapshot).toMatchObject({ degraded: false, rejected: [], ambiguous: [] });
		expect(snapshot.mounts.filter((mount) => mount.on === "/run")).toEqual([
			{ dev: "tmpfs", on: "/run", type: "tmpfs" },
		]);
		expect(snapshot.mounts.filter((mount) => mount.on === "/proc/sys/fs/binfmt_misc")).toEqual([
			{ dev: "binfmt_misc", on: "/proc/sys/fs/binfmt_misc", type: "binfmt_misc" },
		]);
		expect(snapshot.mounts.map((mount) => mount.on)).toEqual([
			"/proc/sys/fs/binfmt_misc",
			"/run/user/1000",
			"/proc",
			"/run",
			"/",
		]);
	});

	it("confirms a linux path by the visible (last) mount, not the hidden one", () => {
		const io = enumerable({ "/": ["run", "proc"], "/run": ["x"], "/proc": ["sys"], "/proc/sys": ["fs"] });
		const rootOnOverlay = parseMountTable(
			"overlay / overlay rw 0 0\nsystemd-1 /run autofs rw 0 0\ntmpfs /run tmpfs rw 0 0",
			"linux",
		);
		expect(createDetector(rootOnOverlay, budget, io, "linux")("/run/x")).toMatchObject({ alias: false, reasons: [] });
		const autofsOverTmpfs = parseMountTable(
			"overlay / overlay rw 0 0\ntmpfs /run tmpfs rw 0 0\nsystemd-1 /run autofs rw 0 0",
			"linux",
		);
		expect(createDetector(autofsOverTmpfs, budget, io, "linux")("/run/x").reasons).toEqual(["fs-type:autofs@/run"]);
	});

	it("drops a linux mount hidden by a later mount at its ancestor, so its paths use the visible mount", () => {
		const overmounted = parseMountTable(
			"overlay / overlay rw 0 0\noverlay /x/y overlay rw 0 0\nsystemd-1 /x autofs rw 0 0",
			"linux",
		);
		expect(overmounted.mounts.map((mount) => mount.on)).toEqual(["/x", "/"]);
		expect(volumeKeyFor(overmounted, (value) => value, "/x/y/f")).toBe("/x");
		const nestedAfter = parseMountTable(
			"overlay / overlay rw 0 0\nsystemd-1 /x autofs rw 0 0\noverlay /x/y overlay rw 0 0",
			"linux",
		);
		expect(nestedAfter.mounts.map((mount) => mount.on)).toEqual(["/x/y", "/x", "/"]);
		expect(volumeKeyFor(nestedAfter, (value) => value, "/x/y/f")).toBe("/x/y");
	});

	it("keys the breaker by the mount point of a stacked linux mount", () => {
		const snapshot = parseMountTable(LINUX_STACKED, "linux");
		expect(volumeKeyFor(snapshot, (value) => value, "/run/x")).toBe("/run");
		expect(volumeKeyFor(snapshot, (value) => value, "/run/user/1000/x")).toBe("/run/user/1000");
		expect(volumeKeyFor(snapshot, (value) => value, "/proc/sys/fs/binfmt_misc/register")).toBe(
			"/proc/sys/fs/binfmt_misc",
		);
	});

	it("records a repeated darwin mount point as ambiguous and confirms nothing beneath it only", () => {
		const snapshot = parseMountTable(DARWIN_REPEATED, "darwin");
		expect(snapshot).toMatchObject({ degraded: false, rejected: [], ambiguous: ["/Volumes/X"] });
		expect(snapshot.mounts.filter((mount) => mount.on === "/Volumes/X")).toEqual([
			{ dev: "/dev/disk3s1", on: "/Volumes/X", type: "apfs" },
		]);
		const io = enumerable({ "/": ["Volumes"], "/Volumes": ["X", "Y"], "/Volumes/X": ["f"], "/Volumes/Y": ["f"] });
		const detect = createDetector(snapshot, budget, io, "darwin");
		expect(detect("/Volumes/X/f")).toMatchObject({
			alias: true,
			reasons: ["mount-point-ambiguous:/Volumes/X@/Volumes/X"],
		});
		expect(detect("/Volumes/Y/f")).toMatchObject({ alias: false, reasons: [] });
		expect(volumeKeyFor(snapshot, (value) => value, "/Volumes/X/f")).toBe("/Volumes/X");
	});

	it("a repeated darwin root makes every path ambiguous", () => {
		const snapshot = parseMountTable("/dev/disk1 on / (apfs, local)\n/dev/disk2 on / (apfs, local)", "darwin");
		const detect = createDetector(snapshot, budget, enumerable({ "/": ["f"] }), "darwin");
		expect(detect("/f")).toMatchObject({ alias: true, reasons: ["mount-point-ambiguous:/"] });
	});
});

// senpi#4790: one row per filesystem type, each mounted at its own point under an overlay root. The confirmed rows
// are the design's measured allowlist (local disk and the measured network/overlay types); every other type
// keeps the inverted default and stays alias-bearing.
const CONFIRMED_TYPES = [
	"apfs",
	"btrfs",
	"exfat",
	"ext4",
	"hfs",
	"nfs",
	"nfs4",
	"ntfs",
	"overlay",
	"tmpfs",
	"virtiofs",
	"xfs",
	"zfs",
] as const;
const FLAGGED_TYPES = [
	"devfs",
	"fuse",
	"fuseblk",
	"fuse.sshfs",
	"macfuse",
	"autofs",
	"proc",
	"sysfs",
	"devtmpfs",
	"cgroup2",
	"binfmt_misc",
	"cifs",
	"smb3",
	"smbfs",
	"9p",
	"squashfs",
	"ext3",
	"ext2",
	"vfat",
	"msdos",
	"unknown",
] as const;
const pointFor = (type: string) => `/m/${type.replace(/\./g, "_")}`;

describe("alias detector: filesystem type classes (senpi#4790)", () => {
	const types = [...CONFIRMED_TYPES, ...FLAGGED_TYPES];
	const table = parseMountTable(
		["overlay / overlay rw 0 0", ...types.map((type) => `src-${type} ${pointFor(type)} ${type} rw 0 0`)].join("\n"),
		"linux",
	);
	const tree: Record<string, string[]> = {
		"/": ["m"],
		"/m": types.map((type) => pointFor(type).slice(3)),
	};
	for (const type of types) tree[pointFor(type)] = ["f"];
	const detect = createDetector(table, budget, enumerable(tree), "linux");

	it("parses every row without degrading", () => {
		expect(table).toMatchObject({ degraded: false, rejected: [], ambiguous: [] });
	});

	it("confirms a plain path on an ext4 root", () => {
		const ext4Root = createDetector(
			parseMountTable("/dev/sda1 / ext4 rw,relatime 0 0", "linux"),
			budget,
			enumerable({ "/": ["home"], "/home": ["runner"], "/home/runner": [".bashrc"] }),
			"linux",
		);
		expect(ext4Root("/home/runner/.bashrc")).toMatchObject({ alias: false, reasons: [] });
	});

	it.each(CONFIRMED_TYPES)("confirms a fully enumerated path on %s", (type) => {
		expect(detect(`${pointFor(type)}/f`)).toMatchObject({ alias: false, reasons: [] });
	});

	it.each(FLAGGED_TYPES)("keeps a path on %s alias-bearing by its type", (type) => {
		expect(detect(`${pointFor(type)}/f`)).toMatchObject({
			alias: true,
			reasons: [`fs-type:${type}@${pointFor(type)}`],
		});
	});

	it("a spelling a case-folding ext4 directory resolves but does not list stays alias-bearing", () => {
		const casefolded = createDetector(
			parseMountTable("/dev/sda1 / ext4 rw 0 0", "linux"),
			budget,
			enumerable({ "/": ["srv"], "/srv": ["Data"], "/srv/Data": ["f"] }),
			"linux",
		);
		expect(casefolded("/srv/Data/f")).toMatchObject({ alias: false, reasons: [] });
		expect(casefolded("/srv/DATA/f")).toMatchObject({ alias: true, reasons: ["not-enumerable@/srv/DATA"] });
	});

	it("a path with no mount entry stays alias-bearing", () => {
		const rootless = { mounts: [{ dev: "x", on: "/m", type: "ext4" }], degraded: false, rejected: [], ambiguous: [] };
		expect(createDetector(rootless, budget, enumerable({ "/": ["m"] }), "linux")("/m")).toMatchObject({
			alias: true,
			reasons: ["fs-type:no-mount-entry"],
		});
	});
});
