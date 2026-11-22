import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	isLocalMessagePath,
	messagePathProjectRoot,
	resolveMessagePath,
} from "../../../src/core/message-path-resolution.ts";
import { rpcCommandPayloadError } from "../../../src/modes/rpc/rpc-input-validation.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-3415-")));
	dirs.push(root);
	mkdirSync(join(root, ".git"));
	const cwd = join(root, "packages", "app");
	mkdirSync(join(cwd, "docs"), { recursive: true });
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "only-at-root.md"), "root");
	writeFileSync(join(root, "docs", "both.md"), "root");
	writeFileSync(join(cwd, "docs", "both.md"), "cwd");
	return { root, cwd };
}

describe("resolveMessagePath (#3415)", () => {
	it("falls back to the project root for a relative path only it holds", () => {
		const { root, cwd } = repository();
		expect(messagePathProjectRoot(cwd)).toBe(root);
		expect(resolveMessagePath({ path: "docs/only-at-root.md", cwd, projectRoot: root })).toEqual({
			status: "found",
			realpath: join(root, "docs", "only-at-root.md"),
			kind: "file",
			base: "project-root",
		});
	});

	it("prefers the session working directory when both hold the path", () => {
		const { root, cwd } = repository();
		expect(resolveMessagePath({ path: "./docs/both.md", cwd, projectRoot: root })).toMatchObject({
			realpath: join(cwd, "docs", "both.md"),
			base: "cwd",
		});
	});

	it("reports every candidate it tried when nothing is there", () => {
		const { root, cwd } = repository();
		expect(resolveMessagePath({ path: "out/report.pdf", cwd, projectRoot: root })).toEqual({
			status: "not_found",
			tried: [join(cwd, "out", "report.pdf"), join(root, "out", "report.pdf")],
		});
	});

	it("resolves `..` and symlinks to the real target, and checks absolute paths", () => {
		const { root, cwd } = repository();
		symlinkSync(join(root, "docs", "only-at-root.md"), join(cwd, "link.md"));
		expect(resolveMessagePath({ path: "link.md", cwd, projectRoot: root })).toMatchObject({
			realpath: join(root, "docs", "only-at-root.md"),
			base: "cwd",
		});
		expect(resolveMessagePath({ path: "../../docs/both.md", cwd, projectRoot: root })).toMatchObject({
			realpath: join(root, "docs", "both.md"),
		});
		expect(resolveMessagePath({ path: join(root, "docs"), cwd, projectRoot: root })).toMatchObject({
			kind: "directory",
			base: "absolute",
		});
	});

	it("refuses an empty path or one with a NUL byte", () => {
		const { root, cwd } = repository();
		for (const path of ["", "   ", "docs\0/both.md"]) {
			expect(resolveMessagePath({ path, cwd, projectRoot: root })).toEqual({ status: "not_found", tried: [] });
		}
	});
});

describe("network and device paths never reach the file system (#3419 review H1)", () => {
	it("refuses every non-local Windows form before any file-system call", () => {
		for (const path of [
			"\\\\attacker\\share\\x.pdf",
			"//attacker/share/x.pdf",
			"\\\\?\\UNC\\host\\s\\x",
			"\\??\\UNC\\host\\s\\x",
			"\\\\.\\pipe\\x",
			"\\\\?\\C:\\x",
		]) {
			expect(resolveMessagePath({ path, cwd: "C:\\work", platform: "win32" })).toEqual({
				status: "not_found",
				tried: [],
			});
		}
		expect(isLocalMessagePath("C:\\work\\a.md", "win32")).toBe(true);
		expect(isLocalMessagePath("\\\\host\\s\\a.md", "win32")).toBe(false);
		expect(isLocalMessagePath("//host/s/a.md", "linux")).toBe(false);
	});

	it("ignores a .git in the home folder when choosing the project root", () => {
		expect(messagePathProjectRoot(homedir())).not.toBe(homedir());
	});
});

describe("resolve_path RPC payload (#3415)", () => {
	it("accepts a path and refuses a missing, empty or oversized one", () => {
		expect(rpcCommandPayloadError({ type: "resolve_path", path: "docs/plan.md" })).toBeUndefined();
		for (const path of [undefined, "", "  ", 42, "x".repeat(4097)]) {
			expect(rpcCommandPayloadError({ type: "resolve_path", path })).toMatch(/path must be/);
		}
	});
});
