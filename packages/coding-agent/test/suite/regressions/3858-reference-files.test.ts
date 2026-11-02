import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { referenceRoot, resolveReference, SECRET } from "./3858-reference-support.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, open: vi.fn(original.open), lstat: vi.fn(original.lstat) };
});

// #3858: same-handle validation, bounded reads, and POSIX path authority.
describe("reference file contract", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		vi.clearAllMocks();
		files = referenceRoot();
	});
	afterEach(() => {
		vi.resetAllMocks();
		vi.restoreAllMocks();
		files.close();
	});

	it.each([
		["missing", "missing"],
		["empty", "empty"],
		["whitespace", "empty"],
		["oversize", "oversize"],
		["utf8", "invalid-utf8"],
		["directory", "non-regular"],
	] as const)("reports the named failure for %s files", async (kind, reason) => {
		const path = join(files.root, kind);
		if (kind === "empty") files.file(kind, "");
		if (kind === "whitespace") files.file(kind, " \n\t ");
		if (kind === "oversize") files.file(kind, "x".repeat(65_537));
		if (kind === "utf8") files.file(kind, new Uint8Array([0xc0, 0xaf]));
		if (kind === "directory") mkdirSync(path);
		await expect(resolveReference({ $file: path }, { root: files.root })).rejects.toMatchObject({
			name: "ConfigReferenceError",
			reason,
		});
	});

	it("accepts exactly 64 KiB", async () => {
		const text = "x".repeat(65_536);
		const path = files.file("limit", text);
		expect(await resolveReference({ $file: path }, { root: files.root })).toBe(text);
	});

	it("rejects unreadable files with a named error", async () => {
		const path = files.file("unreadable", SECRET, 0);
		await expect(resolveReference({ $file: path }, { root: files.root })).rejects.toMatchObject({
			name: "ConfigReferenceError",
			reason: "unreadable",
		});
	});

	it.skipIf(process.platform === "win32")("rejects FIFO without blocking", async () => {
		const path = join(files.root, "fifo");
		execFileSync("mkfifo", [path]);
		await expect(resolveReference({ $file: path }, { root: files.root })).rejects.toMatchObject({
			name: "ConfigReferenceError",
			reason: "non-regular",
		});
	});

	it.skipIf(process.platform === "win32")("rejects group writable files", async () => {
		const path = files.file("writable");
		chmodSync(path, 0o660);
		await expect(resolveReference({ $file: path }, { root: files.root })).rejects.toMatchObject({
			reason: "unsafe-permissions",
		});
	});

	it.skipIf(process.platform === "win32")("rejects a group writable ancestor", async () => {
		const path = files.file("credential");
		chmodSync(files.root, 0o770);
		await expect(resolveReference({ $file: path }, { root: files.root })).rejects.toMatchObject({
			reason: "unsafe-permissions",
		});
		chmodSync(files.root, 0o700);
	});

	it.skipIf(process.platform === "win32")("warns once for a readable secret without disclosing it", async () => {
		const path = files.file("readable", SECRET, 0o644);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await resolveReference({ $file: path }, { root: files.root })).toBe(SECRET);
		await resolveReference({ $file: path }, { root: files.root });
		expect(warning).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warning.mock.calls)).not.toContain(SECRET);
	});

	it.skipIf(process.platform === "win32")("accepts a secure symlink chain", async () => {
		const path = files.file("target");
		const link = join(files.root, "link");
		symlinkSync(path, link);
		expect(await resolveReference({ $file: link }, { root: files.root })).toBe(SECRET);
	});

	it.skipIf(process.platform === "win32")("rejects a changed target inode before reading", async () => {
		const path = files.file("target");
		const replacement = files.file("replacement", "forbidden-replacement");
		const { open } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
			if (target === path) await fs.rename(replacement, path);
			return open(target, flags, mode);
		});
		await expect(resolveReference({ $file: path }, { root: files.root })).rejects.toMatchObject({
			reason: "changed",
		});
	});

	it.skipIf(process.platform === "win32")("rejects foreign ownership before reading file bytes", async () => {
		const path = files.file("foreign");
		const { lstat } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
			const result = await Reflect.apply(lstat, fs, args);
			if (args[0] === path) Object.defineProperty(result, "uid", { value: 2_147_000_000 });
			return result;
		});
		await expect(resolveReference({ $file: path }, { root: files.root })).rejects.toMatchObject({
			reason: "unsafe-owner",
		});
	});
});
