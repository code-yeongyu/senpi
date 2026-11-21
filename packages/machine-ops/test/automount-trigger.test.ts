import { vi } from "vitest";

const state = vi.hoisted(() => ({
	trigger: "",
	fifo: "",
	opened: [] as Promise<unknown>[],
	realpathCalls: [] as string[],
}));

// Inside the fake trigger, `realpath` behaves like Bun's on a macOS automount that does not answer: it opens the path and
// the open never returns. Opening a FIFO that has no writer blocks a real thread of the shared filesystem pool the same way.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async (...args: Parameters<typeof actual.realpath>) => {
			const path = String(args[0]);
			state.realpathCalls.push(path);
			if (state.trigger && (path === state.trigger || path.startsWith(`${state.trigger}/`))) {
				const opened = actual.open(state.fifo, "r");
				state.opened.push(opened);
				await opened;
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			}
			return actual.realpath(...args);
		},
	};
});

vi.mock("../src/files/mount-table.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/files/mount-table.ts")>();
	return {
		...actual,
		readMountTable: async () => [
			{ mountPoint: "/", type: "rootfs" },
			{ mountPoint: state.trigger, type: "autofs" },
			{ mountPoint: `${state.trigger}/mounted`, type: "nfs" },
		],
	};
});

import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unmountedAutomountPath } from "../src/files/automount-trigger.ts";
import { parseDarwinMountTable, parseLinuxMountInfo } from "../src/files/mount-table.ts";
import { withFileMutationQueue } from "../src/files/mutation-queue.ts";
import { canonicalizeFilesystemPath } from "../src/policy/filesystem.ts";

const isWindows = process.platform === "win32";

describe("mount table parsing", () => {
	it("reads mount points and types from /proc/self/mountinfo, unescaping octal", () => {
		// given
		const text = [
			"22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
			"36 25 0:31 / /proc/sys/fs/binfmt_misc rw,relatime shared:13 - autofs systemd-1 rw,fd=32,direct",
			"90 22 0:50 / /mnt/my\\040share rw,relatime - nfs4 server:/export rw",
		].join("\n");

		// when / then
		expect(parseLinuxMountInfo(text)).toEqual([
			{ mountPoint: "/", type: "ext4" },
			{ mountPoint: "/proc/sys/fs/binfmt_misc", type: "autofs" },
			{ mountPoint: "/mnt/my share", type: "nfs4" },
		]);
	});

	it("reads mount points and types from macOS mount output", () => {
		// given
		const text = [
			"/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
			"map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
			"//user@nas/My Share on /Users/me/NAS/My Share (smbfs, nodev, nosuid, mounted by me)",
		].join("\n");

		// when / then
		expect(parseDarwinMountTable(text)).toEqual([
			{ mountPoint: "/", type: "apfs" },
			{ mountPoint: "/System/Volumes/Data/home", type: "autofs" },
			{ mountPoint: "/Users/me/NAS/My Share", type: "smbfs" },
		]);
	});
});

describe("unmountedAutomountPath", () => {
	const view = {
		mounts: [
			{ mountPoint: "/", type: "apfs" },
			{ mountPoint: "/System/Volumes/Data/home", type: "autofs" },
			{ mountPoint: "/System/Volumes/Data/home/alice", type: "nfs" },
		],
		aliases: new Map([["/home", "/System/Volumes/Data/home"]]),
	};

	it("maps a path through the root alias onto the trigger it reaches", () => {
		expect(unmountedAutomountPath("/home/someone/work/x", view)).toBe("/System/Volumes/Data/home/someone/work/x");
		expect(unmountedAutomountPath("/home", view)).toBe("/System/Volumes/Data/home");
	});

	it("leaves a filesystem already mounted below the trigger, and every other path, to normal resolution", () => {
		expect(unmountedAutomountPath("/home/alice/notes.md", view)).toBeUndefined();
		expect(unmountedAutomountPath("/homework/x", view)).toBeUndefined();
		expect(unmountedAutomountPath("/Users/me/x", view)).toBeUndefined();
	});
});

describe.skipIf(isWindows)("paths under an automount trigger that does not answer", () => {
	let root = "";
	let note = "";

	beforeAll(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "automount-trigger-"));
		state.trigger = join(root, "trigger");
		state.fifo = join(root, "unanswered");
		mkdirSync(state.trigger);
		execFileSync("mkfifo", [state.fifo]);
		note = join(root, "note.txt");
		writeFileSync(note, "still readable");
	});

	afterAll(async () => {
		// While a writer end is open, every parked open of the FIFO completes and every queued one completes at once, so the
		// writer stays open until all of them have settled and returned their pool threads.
		let writer: number | undefined;
		try {
			writer = openSync(state.fifo, constants.O_WRONLY | constants.O_NONBLOCK);
		} catch {
			// ENXIO: no open is parked, nothing to release.
		}
		for (const opened of await Promise.allSettled(state.opened)) {
			if (opened.status === "fulfilled") await (opened.value as { close(): Promise<void> }).close();
		}
		if (writer !== undefined) closeSync(writer);
		rmSync(root, { recursive: true, force: true });
	});

	it("never hands them to realpath, so resolving many of them leaves the filesystem pool free", async () => {
		// given
		const targets = Array.from({ length: 32 }, (_, index) =>
			join(state.trigger, `user-${index}`, "work", "file.txt"),
		);

		// when
		const canonical = await Promise.all(targets.map((target) => canonicalizeFilesystemPath(target)));
		const unrelatedRead = await Promise.race([
			readFile(note, "utf8"),
			new Promise<string>((resolveRace) => setTimeout(() => resolveRace("pool exhausted"), 5000).unref()),
		]);

		// then
		expect(unrelatedRead).toBe("still readable");
		expect(canonical).toEqual(targets);
		expect(state.realpathCalls.filter((path) => path.startsWith(state.trigger))).toEqual([]);
	}, 30_000);

	it("keys a mutation of such a path without resolving it", async () => {
		// given
		const target = join(state.trigger, "someone", "draft.md");
		const before = state.realpathCalls.length;

		// when
		const result = await withFileMutationQueue(target, async () => "ran");

		// then
		expect(result).toBe("ran");
		expect(state.realpathCalls.slice(before)).toEqual([]);
	});
});
