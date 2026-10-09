import { vi } from "vitest";

const fsState = vi.hoisted(() => ({
	hangRealpath: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async (...args: Parameters<typeof actual.realpath>) => {
			if (fsState.hangRealpath) return await new Promise<never>(() => {});
			return actual.realpath(...args);
		},
	};
});

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { foldPathForCaseInsensitiveFilesystem } from "../src/core/tools/bounded-realpath.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { canonicalizeFilesystemPath } from "../src/core/tools/filesystem-policy.ts";
import { realpathWithoutOpen, realpathWithoutOpenStrict } from "../src/utils/paths.ts";

const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;
const isCaseSensitiveFilesystem = process.platform === "linux";

let root = "";

afterEach(() => {
	fsState.hangRealpath = false;
	if (root) {
		rmSync(root, { recursive: true, force: true });
		root = "";
	}
});

function createRoot(): string {
	root = mkdtempSync(join(realpathSync(tmpdir()), "bounded-realpath-"));
	return root;
}

describe("realpathWithoutOpenStrict", () => {
	it("tolerates a missing descendant, which a not-yet-created target needs", () => {
		// given
		const dir = createRoot();

		// when / then
		expect(realpathWithoutOpenStrict(join(dir, "missing", "leaf.txt"))).toBe(join(dir, "missing", "leaf.txt"));
	});

	it.skipIf(isWindows)("throws ELOOP on a symlink loop where the tolerant walker guesses", () => {
		// given
		const dir = createRoot();
		symlinkSync("b", join(dir, "a"), "dir");
		symlinkSync("a", join(dir, "b"), "dir");

		// when / then
		expect(() => realpathWithoutOpenStrict(join(dir, "a", "file.txt"))).toThrow(/ELOOP/);
		expect(realpathWithoutOpen(join(dir, "a", "file.txt"))).toContain("file.txt");
	});

	it.skipIf(isWindows || isRoot)("throws EACCES when a component cannot be traversed", () => {
		// given
		const dir = createRoot();
		const blocked = join(dir, "blocked");
		mkdirSync(join(blocked, "inner"), { recursive: true });
		chmodSync(blocked, 0o000);
		try {
			// when / then
			expect(() => realpathWithoutOpenStrict(join(blocked, "inner", "file.txt"))).toThrow(/EACCES/);
		} finally {
			chmodSync(blocked, 0o755);
		}
	});
});

describe("bounded resolution", () => {
	it("canonicalizes within the deadline when realpath never returns", async () => {
		// given
		const dir = createRoot();
		mkdirSync(join(dir, "logs"));
		fsState.hangRealpath = true;

		// when
		const canonical = await canonicalizeFilesystemPath(join(dir, "logs", "out.log"));

		// then
		expect(canonical).toBe(join(dir, "logs", "out.log"));
	}, 20_000);

	it("still serializes one file when realpath never returns", async () => {
		// given
		const dir = createRoot();
		const target = join(dir, "out.log");
		writeFileSync(target, "start");
		fsState.hangRealpath = true;
		const order: string[] = [];
		const releaseFirst = Promise.withResolvers<void>();

		// when
		const first = withFileMutationQueue(target, async () => {
			order.push("first");
			await releaseFirst.promise;
		});
		const second = withFileMutationQueue(target, async () => {
			order.push("second");
		});
		releaseFirst.resolve();
		await Promise.all([first, second]);

		// then
		expect(order).toEqual(["first", "second"]);
	}, 30_000);
});

describe("case-insensitive identity folding", () => {
	// The platform is stubbed so both branches run on every CI runner: asserted against the host's own
	// platform, the Linux branch reduces to "unchanged", which a deleted fold also satisfies.
	function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		try {
			return run();
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	}

	it("lowercases and NFC-normalizes the key where the filesystem ignores case", () => {
		// given: "e" + combining acute (NFD) spelled with capitals
		const spelled = "/Volumes/Data/Cafe\u0301/Notes.txt";

		// when
		const folded = withPlatform("darwin", () => foldPathForCaseInsensitiveFilesystem(spelled));

		// then: precomposed \u00e9, all lowercase
		expect(folded).toBe("/volumes/data/caf\u00e9/notes.txt");
		expect(folded).not.toBe(spelled);
	});

	it("leaves the key untouched where the filesystem is case-sensitive", () => {
		// given
		const spelled = "/home/user/Cafe\u0301/Notes.txt";

		// when
		const folded = withPlatform("linux", () => foldPathForCaseInsensitiveFilesystem(spelled));

		// then
		expect(folded).toBe(spelled);
	});

	it.skipIf(isCaseSensitiveFilesystem || isWindows)(
		"serializes two case spellings of one file",
		async () => {
			// given
			const dir = createRoot();
			writeFileSync(join(dir, "Notes.txt"), "start");
			const order: string[] = [];
			const releaseFirst = Promise.withResolvers<void>();
			const secondStarted = Promise.withResolvers<void>();

			// when
			const first = withFileMutationQueue(join(dir, "Notes.txt"), async () => {
				order.push("first");
				await releaseFirst.promise;
			});
			const second = withFileMutationQueue(join(dir, "notes.txt"), async () => {
				order.push("second");
				secondStarted.resolve();
			});
			const early = await Promise.race([
				secondStarted.promise.then(() => "second-started"),
				new Promise<string>((resolveRace) => setImmediate(() => resolveRace("still-queued"))),
			]);

			// then
			expect(early).toBe("still-queued");
			releaseFirst.resolve();
			await Promise.all([first, second]);
			expect(order).toEqual(["first", "second"]);
		},
		20_000,
	);
});
