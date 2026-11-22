import { constants } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSnapshotFileCopier, type SnapshotFileOperations } from "../../src/runtime-snapshot/file-copier.ts";

function failure(code: string): Error {
	return Object.assign(new Error(code), { code });
}

function recordingOperations(refuse: Partial<Record<"force" | "clone" | "link" | "copy", string>>) {
	const attempts: string[] = [];
	const operations: SnapshotFileOperations = {
		async copyFile(_source, _target, mode) {
			const kind =
				mode === constants.COPYFILE_FICLONE_FORCE
					? "force"
					: mode === constants.COPYFILE_FICLONE
						? "clone"
						: "copy";
			attempts.push(kind);
			const code = refuse[kind];
			if (code) throw failure(code);
		},
		async link() {
			attempts.push("link");
			if (refuse.link) throw failure(refuse.link);
		},
	};
	return { attempts, operations };
}

// #2408: a hardlink shares the install's file, so an in-place rewrite of it would change the
// snapshot; a copy-on-write clone never does, so it is always tried first.
describe("snapshot file copier (#2408)", () => {
	it("clones where the filesystem can and never falls back for later files", async () => {
		const { attempts, operations } = recordingOperations({});
		const copier = createSnapshotFileCopier("linux", operations);
		await copier.copy("a", "b");
		await copier.copy("c", "d");
		expect(attempts).toEqual(["force", "force"]);
		expect(copier.mode).toBe("clone");
	});

	it("hardlinks only where cloning is unsupported, then keeps linking", async () => {
		const { attempts, operations } = recordingOperations({ force: "EOPNOTSUPP" });
		const copier = createSnapshotFileCopier("linux", operations);
		await copier.copy("a", "b");
		await copier.copy("c", "d");
		expect(attempts).toEqual(["force", "link", "link"]);
	});

	it("copies across volumes, where neither a clone nor a link is possible", async () => {
		const { attempts, operations } = recordingOperations({ force: "EXDEV", link: "EXDEV" });
		const copier = createSnapshotFileCopier("linux", operations);
		await copier.copy("a", "b");
		expect(attempts).toEqual(["force", "link", "copy"]);
		expect(copier.mode).toBe("copy");
	});

	it("never hardlinks on macOS when the runtime cannot force a clone", async () => {
		const { attempts, operations } = recordingOperations({ force: "ENOSYS" });
		const copier = createSnapshotFileCopier("darwin", operations);
		await copier.copy("a", "b");
		expect(attempts).toEqual(["force", "clone"]);
		expect(copier.mode).toBe("clone-or-copy");
	});

	it("reports a missing source instead of trying another mode", async () => {
		const { attempts, operations } = recordingOperations({ force: "ENOENT" });
		const copier = createSnapshotFileCopier("linux", operations);
		await expect(copier.copy("a", "b")).rejects.toThrow("ENOENT");
		expect(attempts).toEqual(["force"]);
	});
});
