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
