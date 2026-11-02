import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realpathWithoutOpen } from "../src/utils/paths.ts";

const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;

let root = "";

afterEach(() => {
	if (root) {
		rmSync(root, { recursive: true, force: true });
		root = "";
	}
});

function createRoot(): string {
	root = mkdtempSync(join(realpathSync(tmpdir()), "realpath-without-open-"));
	return root;
}

describe("realpathWithoutOpen", () => {
	it("returns an existing path without symlinks unchanged", () => {
		// given
		const dir = createRoot();
		const file = join(dir, "file.txt");
		writeFileSync(file, "hello");

		// when / then
		expect(realpathWithoutOpen(file)).toBe(file);
		expect(realpathWithoutOpen(dir)).toBe(dir);
	});

	it.skipIf(isWindows)("resolves symlinked components like realpath(3)", () => {
		// given
		const dir = createRoot();
		const real = join(dir, "real");
		const link = join(dir, "link");
		mkdirSync(real);
		writeFileSync(join(real, "file.txt"), "hello");
		symlinkSync(real, link, "dir");
		const throughLink = join(link, "file.txt");

		// when / then
		expect(realpathWithoutOpen(throughLink)).toBe(join(real, "file.txt"));
		expect(realpathWithoutOpen(throughLink)).toBe(realpathSync(throughLink));
	});

	it.skipIf(isWindows)("keeps missing trailing components verbatim under the resolved parent", () => {
		// given
		const dir = createRoot();
		const real = join(dir, "real");
		const link = join(dir, "link");
		mkdirSync(real);
		symlinkSync(real, link, "dir");

		// when / then
		expect(realpathWithoutOpen(join(link, "not", "yet", "created.log"))).toBe(
			join(real, "not", "yet", "created.log"),
		);
	});

	it("returns the normalized input when the first component is missing", () => {
		// given
		const dir = createRoot();
		const missing = join(dir, "missing", "..", "missing", "child");

		// when / then
		expect(realpathWithoutOpen(missing)).toBe(join(dir, "missing", "child"));
	});

	it.skipIf(isWindows)("stops on a symlink loop without throwing", () => {
		// given
		const dir = createRoot();
		symlinkSync("b", join(dir, "a"), "dir");
		symlinkSync("a", join(dir, "b"), "dir");

		// when
		const resolved = realpathWithoutOpen(join(dir, "a", "file.txt"));

		// then
		expect(resolved.endsWith(join("file.txt"))).toBe(true);
		expect(resolved.startsWith(dir)).toBe(true);
	});

	// Bun's fs.realpath* opens every directory it walks, so an execute-only directory makes it fail
	// with EACCES; lstat/readlink only need search permission, which is what realpath(3) relies on.
	it.skipIf(isWindows || isRoot)("resolves through an execute-only directory", () => {
		// given
		const dir = createRoot();
		const executeOnly = join(dir, "noread");
		const child = join(executeOnly, "child");
		mkdirSync(child, { recursive: true });
		chmodSync(executeOnly, 0o111);
		try {
			// when / then
			expect(realpathWithoutOpen(join(child, "file.txt"))).toBe(join(child, "file.txt"));
		} finally {
			chmodSync(executeOnly, 0o755);
		}
	});
});
