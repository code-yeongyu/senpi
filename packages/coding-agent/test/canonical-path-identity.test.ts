import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { canonicalizeFilesystemPath } from "../src/core/tools/filesystem-policy.ts";
import { realpathWithoutOpen } from "../src/utils/paths.ts";

const isWindows = process.platform === "win32";

let root = "";

afterEach(() => {
	if (root) {
		rmSync(root, { recursive: true, force: true });
		root = "";
	}
});

function createRoot(): string {
	root = mkdtempSync(join(realpathSync(tmpdir()), "canonical-identity-"));
	return root;
}

// `entry -> "jump/../secret"` with `jump -> outside/subdir`: the `..` belongs to the link target, so
// it is applied after `jump` expands and the file reached is outside/secret. Collapsing it lexically
// instead answers allowed/secret, which would let a containment policy approve one directory while
// the read leaves it, and would key one file as two in the mutation queue. The fixture reads through
// the requested path and pins that byte, so it cannot encode the wrong side of the escape.
function createSymlinkEscapeFixture(dir: string): { readonly requested: string; readonly real: string } {
	const allowed = join(dir, "allowed");
	const outside = join(dir, "outside");
	mkdirSync(join(outside, "subdir"), { recursive: true });
	mkdirSync(join(outside, "secret"), { recursive: true });
	mkdirSync(join(allowed, "secret"), { recursive: true });
	writeFileSync(join(outside, "secret", "f.txt"), "outside");
	writeFileSync(join(allowed, "secret", "f.txt"), "allowed");
	symlinkSync(join(outside, "subdir"), join(allowed, "jump"), "dir");
	symlinkSync("jump/../secret", join(allowed, "entry"), "dir");
	const requested = join(allowed, "entry", "f.txt");
	expect(readFileSync(requested, "utf8")).toBe("outside");
	return { requested, real: join(outside, "secret", "f.txt") };
}

describe("open-free resolution agrees with realpath(3)", () => {
	// The oracle here is the file the I/O opens, not `realpathSync`: Node's JS `fs.realpathSync`
	// collapses this `..` lexically and answers allowed/secret (measured on node v24 and v26), while
	// `realpathSync.native` and Bun agree with the kernel. Vitest runs under Node, so pinning the
	// walker to `realpathSync` would pin that bug into the suite.
	it.skipIf(isWindows)("applies `..` in a symlink target after following that target's symlinks", () => {
		// given
		const dir = createRoot();
		const { requested, real } = createSymlinkEscapeFixture(dir);

		// when / then
		expect(realpathWithoutOpen(requested)).toBe(real);
		expect(readFileSync(realpathWithoutOpen(requested), "utf8")).toBe(readFileSync(requested, "utf8"));
	});

	it.skipIf(isWindows)("resolves a relative symlink target against the link's own directory", () => {
		// given
		const dir = createRoot();
		const nested = join(dir, "nested");
		mkdirSync(join(nested, "real"), { recursive: true });
		writeFileSync(join(nested, "real", "target.txt"), "nested");
		symlinkSync("real", join(nested, "alias"), "dir");
		const requested = join(nested, "alias", "target.txt");

		// when / then
		expect(realpathWithoutOpen(requested)).toBe(realpathSync(requested));
		expect(realpathWithoutOpen(requested)).toBe(join(nested, "real", "target.txt"));
	});

	it("keeps a missing descendant under its resolved parent", () => {
		// given
		const dir = createRoot();

		// when / then
		expect(realpathWithoutOpen(join(dir, "missing", "leaf.txt"))).toBe(join(dir, "missing", "leaf.txt"));
	});
});

describe("canonicalizeFilesystemPath", () => {
	it.skipIf(isWindows)("fails closed on a symlink loop instead of answering with the requested path", async () => {
		// given
		const dir = createRoot();
		symlinkSync("b", join(dir, "a"), "dir");
		symlinkSync("a", join(dir, "b"), "dir");

		// when / then
		await expect(canonicalizeFilesystemPath(join(dir, "a", "file.txt"))).rejects.toThrow(/ELOOP/);
	});

	it.skipIf(isWindows)("resolves a symlink-escaping target to the file the I/O will reach", async () => {
		// given
		const dir = createRoot();
		const { requested, real } = createSymlinkEscapeFixture(dir);

		// when / then
		await expect(canonicalizeFilesystemPath(requested)).resolves.toBe(real);
	});
});

describe("file mutation queue identity", () => {
	it.skipIf(isWindows)(
		"serializes two spellings that name one file",
		async () => {
			// given
			const dir = createRoot();
			const { requested, real } = createSymlinkEscapeFixture(dir);
			const started: string[] = [];
			const releaseFirst = Promise.withResolvers<void>();
			const firstEntered = Promise.withResolvers<void>();

			// when
			const first = withFileMutationQueue(requested, async () => {
				started.push("first");
				firstEntered.resolve();
				await releaseFirst.promise;
			});
			await firstEntered.promise;
			const second = withFileMutationQueue(real, async () => {
				started.push("second");
			});
			// Registrations are serialized, so a call on an UNRELATED key whose callback has run proves
			// `second` finished registering. Its own queue is empty, so it cannot wait on the held lock.
			// If the two spellings had produced different keys, `second` would have run by now too.
			await withFileMutationQueue(join(dir, "unrelated.txt"), async () => undefined);

			// then
			expect(started).toEqual(["first"]);
			releaseFirst.resolve();
			await Promise.all([first, second]);
			expect(started).toEqual(["first", "second"]);
		},
		20_000,
	);
});
