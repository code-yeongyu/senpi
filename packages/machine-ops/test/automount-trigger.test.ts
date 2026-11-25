import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { access, lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	answerAutomountTriggersFrom,
	createAutomountTriggerLookup,
	type MountView,
	unmountedAutomountPath,
} from "../src/files/automount-trigger.ts";
import { type MountEntry, parseDarwinMountTable, parseLinuxMountInfo } from "../src/files/mount-table.ts";
import { withFileMutationQueue } from "../src/files/mutation-queue.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { canonicalizeFilesystemPath } from "../src/policy/filesystem.ts";
import { checkPath } from "../src/policy/gate.ts";
import type { OpContext } from "../src/types.ts";

// Observation only: every in-process filesystem call stays real, and the tests read which paths reached one.
vi.mock("node:fs/promises", { spy: true });

const isWindows = process.platform === "win32";

const viewOf = (mounts: readonly MountEntry[], caseInsensitive = false): MountView => ({
	mounts,
	aliases: new Map(),
	caseInsensitive,
});

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
	const view: MountView = {
		mounts: [
			{ mountPoint: "/", type: "apfs" },
			{ mountPoint: "/System/Volumes/Data/home", type: "autofs" },
			{ mountPoint: "/System/Volumes/Data/home/alice", type: "nfs" },
		],
		aliases: new Map([["/home", "/System/Volumes/Data/home"]]),
		caseInsensitive: false,
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

	it("treats a filesystem stacked on the trigger's own mount point as mounted, whichever entry the table lists first", () => {
		// given: an x-systemd.automount share and the gpt-auto /boot, unmounted and then mounted over their autofs entry
		const autofs = [
			"22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
			"40 22 0:40 / /mnt/nas rw,relatime shared:20 - autofs systemd-1 rw,fd=45,direct",
			"41 22 0:41 / /boot rw,relatime shared:21 - autofs systemd-1 rw,fd=46,direct",
		];
		const mounted = [
			"90 40 0:50 / /mnt/nas rw,relatime shared:30 - nfs4 server:/export rw",
			"91 41 259:1 / /boot rw,relatime shared:31 - vfat /dev/nvme0n1p1 rw",
		];
		const linux = (lines: string[]): MountView => viewOf(parseLinuxMountInfo(lines.join("\n")));

		// when / then
		expect(unmountedAutomountPath("/mnt/nas/link/secret", linux(autofs))).toBe("/mnt/nas/link/secret");
		expect(unmountedAutomountPath("/mnt/nas/link/secret", linux([...autofs, ...mounted]))).toBeUndefined();
		expect(unmountedAutomountPath("/boot/efi/x", linux([...autofs, ...mounted]))).toBeUndefined();
		expect(unmountedAutomountPath("/mnt/nas/link/secret", linux([...mounted, ...autofs]))).toBeUndefined();
	});

	it("treats a macOS direct-map share mounted over its autofs entry as mounted", () => {
		// given
		const trigger = "map auto_nas on /Volumes/nas (autofs, automounted, nobrowse)";
		const share = "server:/export on /Volumes/nas (nfs, nodev, nosuid, automounted, nobrowse)";
		const darwin = (lines: string[]): MountView => viewOf(parseDarwinMountTable(lines.join("\n")), true);

		// when / then
		expect(unmountedAutomountPath("/Volumes/nas/link/secret", darwin([trigger]))).toBe("/Volumes/nas/link/secret");
		expect(unmountedAutomountPath("/Volumes/nas/link/secret", darwin([trigger, share]))).toBeUndefined();
	});

	it("matches mount points and root aliases regardless of case on a case-insensitive volume", () => {
		// given
		const folded: MountView = { ...view, caseInsensitive: true };

		// when / then
		expect(unmountedAutomountPath("/HOME/someone/x", folded)).toBe("/System/Volumes/Data/home/someone/x");
		expect(unmountedAutomountPath("/System/Volumes/Data/HOME/someone/x", folded)).toBe(
			"/System/Volumes/Data/home/someone/x",
		);
		expect(unmountedAutomountPath("/home/ALICE/notes.md", folded)).toBeUndefined();
		expect(unmountedAutomountPath("/HOME/someone/x", view)).toBeUndefined();
	});
});

describe("createAutomountTriggerLookup", () => {
	const unmounted = viewOf([
		{ mountPoint: "/", type: "ext4" },
		{ mountPoint: "/home", type: "autofs" },
	]);
	const aliceMounted = viewOf([...unmounted.mounts, { mountPoint: "/home/alice", type: "nfs" }]);

	function scriptedReader(views: readonly MountView[]): { read: () => Promise<MountView>; reads: () => number } {
		let reads = 0;
		return {
			read: async () => views[Math.min(reads++, views.length - 1)] ?? unmounted,
			reads: () => reads,
		};
	}

	it("re-reads the mount view before a trigger answer, so a home that mounted since is resolved normally", async () => {
		// given
		const reader = scriptedReader([unmounted, aliceMounted]);
		const lookup = createAutomountTriggerLookup(reader.read);

		// when
		const whileUnmounted = await lookup("/home/alice/link/x");
		const afterMount = await lookup("/home/alice/link/x");

		// then
		expect(whileUnmounted).toBe("/home/alice/link/x");
		expect(afterMount).toBeUndefined();
		expect(reader.reads()).toBe(2);
	});

	it("classifies other paths from the cached view, and shares one re-read among concurrent trigger answers", async () => {
		// given
		const reader = scriptedReader([unmounted]);
		const lookup = createAutomountTriggerLookup(reader.read);
		await lookup("/srv/x");

		// when
		await lookup("/srv/y");
		const readsForOtherPaths = reader.reads();
		const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => lookup(`/home/user-${index}/x`)));

		// then
		expect(readsForOtherPaths).toBe(1);
		expect(answers).toEqual(Array.from({ length: 8 }, (_, index) => `/home/user-${index}/x`));
		expect(reader.reads()).toBe(2);
	});
});

// A temporary directory stands in for the trigger, which the automounter "mounts" the moment anything outside this
// process opens it. Each home under it holds `link`, a symlink to a directory the policy denies.
describe.skipIf(isWindows)("resolvers on paths under an automount trigger that has not mounted", () => {
	const mountedLater: MountEntry[] = [];
	let root = "";
	let trigger = "";
	let denied = "";
	let restore = (): void => {};
	const readView = async (): Promise<MountView> =>
		viewOf([{ mountPoint: "/", type: "ext4" }, { mountPoint: trigger, type: "autofs" }, ...mountedLater]);

	function homeWithLink(name: string): string {
		const home = join(trigger, name);
		mkdirSync(home);
		symlinkSync(denied, join(home, "link"));
		return home;
	}

	function inProcessCallsUnder(dir: string): string[] {
		return [access, lstat, open, readdir, readlink, realpath, stat]
			.flatMap((fn) => vi.mocked(fn).mock.calls.map((call) => String(call[0])))
			.filter((path) => path === dir || path.startsWith(`${dir}/`));
	}

	const ctx = (): OpContext => ({
		scope: { id: "automount-test" },
		principal: { kind: "local-session", id: "automount-test" },
		signal: new AbortController().signal,
		limits: DEFAULT_LIMITS,
		policy: {
			filesystem: async ({ canonicalPath }) =>
				canonicalPath === denied || canonicalPath.startsWith(`${denied}/`)
					? { allow: false, reason: "denied directory" }
					: { allow: true },
		},
	});

	beforeAll(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "automount-trigger-"));
		trigger = join(root, "trigger");
		denied = join(root, "denied");
		mkdirSync(trigger);
		mkdirSync(denied);
		restore = answerAutomountTriggersFrom(readView);
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterAll(() => {
		restore();
		rmSync(root, { recursive: true, force: true });
	});

	it("lets the policy see where a symlink on a share that has not mounted yet leads, resolved outside this process", async () => {
		// given
		const home = homeWithLink("alice");
		const target = join(home, "link", "secret.txt");

		// when
		const decision = checkPath(target, "read", "files.read", ctx());

		// then
		await expect(decision).rejects.toMatchObject({ code: "policy_denied", message: "denied directory" });
		expect(await canonicalizeFilesystemPath(target)).toBe(join(denied, "secret.txt"));
		expect(inProcessCallsUnder(trigger)).toEqual([]);
	});

	it("refuses a path whose automounter never answers, killing the resolver at its deadline", async () => {
		// given
		const home = homeWithLink("dave");
		const target = join(home, "link", "secret.txt");
		let exited: Promise<unknown[]> | undefined;
		const restoreWedged = answerAutomountTriggersFrom(readView, {
			deadlineMs: 300,
			command: () => ({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1 << 30)"] }),
			onSpawn: (child: ChildProcess) => {
				exited = once(child, "exit");
			},
		});

		// when
		const canonical = canonicalizeFilesystemPath(target);

		// then
		try {
			await expect(canonical).rejects.toMatchObject({
				code: "policy_denied",
				message: expect.stringContaining("automount that did not answer"),
			});
			expect((await exited)?.[1]).toBe("SIGKILL");
			expect(inProcessCallsUnder(trigger)).toEqual([]);
		} finally {
			restoreWedged();
		}
	});

	it("keys a mutation of such a path from its text, apart from the file its symlink names", async () => {
		// given
		const home = homeWithLink("carol");
		writeFileSync(join(denied, "draft.md"), "draft");
		let releaseHeld = (): void => {};
		const held = new Promise<void>((resolveHeld) => {
			releaseHeld = resolveHeld;
		});
		let heldStarted = (): void => {};
		const started = new Promise<void>((resolveStarted) => {
			heldStarted = resolveStarted;
		});
		const throughTrigger = withFileMutationQueue(join(home, "link", "draft.md"), async () => {
			heldStarted();
			await held;
			return "through trigger";
		});
		await started;

		// when: the same file by its real path runs while the trigger spelling still holds its slot
		const direct = await withFileMutationQueue(join(denied, "draft.md"), async () => "direct");
		releaseHeld();

		// then
		expect(direct).toBe("direct");
		expect(await throughTrigger).toBe("through trigger");
		expect(inProcessCallsUnder(trigger)).toEqual([]);
	});

	it("resolves a home in this process as soon as it has mounted, without waiting for the view to age", async () => {
		// given: the view is read while the home has not mounted
		const home = homeWithLink("bob");
		const target = join(home, "link", "secret.txt");
		await canonicalizeFilesystemPath(target);
		vi.clearAllMocks();

		// when: the automounter mounts the home
		mountedLater.push({ mountPoint: home, type: "nfs" });
		const canonical = await canonicalizeFilesystemPath(target);
		mountedLater.length = 0;

		// then
		expect(canonical).toBe(join(denied, "secret.txt"));
		expect(inProcessCallsUnder(home)).toContain(target);
	});
});
