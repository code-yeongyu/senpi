import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isExternalPath } from "../../src/core/extensions/builtin/permission-system/external-dir.ts";

// Filesystem-backed resolution: these cases need real directories, symlinks, and modes.
describe("external-dir path resolution", () => {
	describe("isExternalPath", () => {
		it.skipIf(process.platform === "win32")("keeps relative non-existent paths inside a symlinked cwd", () => {
			const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-real-"));
			const linkRoot = path.join(os.tmpdir(), `external-dir-link-${process.pid}-${Date.now()}`);
			fs.symlinkSync(realRoot, linkRoot, "dir");
			try {
				expect(isExternalPath("src/new.ts", linkRoot)).toBe(false);
			} finally {
				fs.rmSync(linkRoot, { force: true });
				fs.rmSync(realRoot, { recursive: true, force: true });
			}
		});

		// Resolution must never open(2) a path component: Bun's fs.realpath* opens every
		// directory it resolves, so an execute-only directory fails with EACCES (and an autofs
		// trigger such as /home blocks the whole process). lstat + readlink need only search
		// permission, which is what realpath(3) itself relies on.
		it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
			"keeps a not-yet-created file under an execute-only directory inside cwd internal",
			() => {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-noread-"));
				const realCwd = path.join(root, "real");
				const executeOnly = path.join(realCwd, "noread");
				const linkCwd = path.join(root, "link");
				fs.mkdirSync(executeOnly, { recursive: true });
				fs.chmodSync(executeOnly, 0o111);
				fs.symlinkSync(realCwd, linkCwd, "dir");
				try {
					expect(isExternalPath(path.join(realCwd, "noread", "new.txt"), realCwd)).toBe(false);
					expect(isExternalPath(path.join(linkCwd, "noread", "new.txt"), linkCwd)).toBe(false);
				} finally {
					fs.chmodSync(executeOnly, 0o755);
					fs.rmSync(root, { recursive: true, force: true });
				}
			},
		);

		it.skipIf(process.platform === "win32")("reports a symlink inside cwd that points outside as external", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-escape-"));
			const cwd = path.join(root, "project");
			const outside = path.join(root, "outside");
			fs.mkdirSync(cwd);
			fs.mkdirSync(outside);
			// Relative link target: it must resolve against the link's own directory.
			fs.symlinkSync(path.join("..", "outside"), path.join(cwd, "escape"), "dir");
			try {
				expect(isExternalPath(path.join(cwd, "escape", "file.txt"), cwd)).toBe(true);
				expect(isExternalPath(path.join(cwd, "kept", "file.txt"), cwd)).toBe(false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		it.skipIf(process.platform === "win32")("stops on a symlink loop without throwing", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-loop-"));
			const cwd = path.join(root, "project");
			fs.mkdirSync(cwd);
			fs.symlinkSync("b", path.join(cwd, "a"), "dir");
			fs.symlinkSync("a", path.join(cwd, "b"), "dir");
			try {
				expect(isExternalPath(path.join(cwd, "a", "file.txt"), cwd)).toBe(false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});
});
