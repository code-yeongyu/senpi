import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeFilesystemPath, composeFilesystemPolicies } from "../src/policy/filesystem.ts";

const io = vi.hoisted(() => ({
	hangRealpath: false,
	hangLstat: false,
	realpathError: "",
	lstatError: "",
	readlinkError: "",
	lstatCalls: [] as string[],
	links: new Map<string, string>(),
	missing: new Set<string>(),
	lateRealpath: undefined as ((value: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const errno = (code: string) => Object.assign(new Error(code), { code });
	return {
		...actual,
		realpath: async (path: string) => {
			if (io.realpathError) throw errno(io.realpathError);
			if (io.hangRealpath)
				return new Promise<string>((done) => {
					io.lateRealpath = done;
				});
			return actual.realpath(path);
		},
		lstat: async (path: string) => {
			io.lstatCalls.push(path);
			if (io.hangLstat) return new Promise<never>(() => {});
			if (io.lstatError) throw errno(io.lstatError);
			if (io.missing.has(path)) throw errno("ENOENT");
			if (io.links.has(path)) return { isSymbolicLink: () => true };
			return actual.lstat(path);
		},
		readlink: async (path: string) => {
			if (io.readlinkError) throw errno(io.readlinkError);
			const target = io.links.get(path);
			return target === undefined ? actual.readlink(path) : target;
		},
	};
});

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "resolution-regression-"));
});
afterEach(() => {
	vi.useRealTimers();
	io.hangRealpath = false;
	io.hangLstat = false;
	io.realpathError = "";
	io.lstatError = "";
	io.readlinkError = "";
	io.lstatCalls.length = 0;
	io.links.clear();
	io.missing.clear();
	io.lateRealpath = undefined;
	rmSync(root, { recursive: true, force: true });
});

async function fallback(path: string, signal?: AbortSignal): Promise<string> {
	io.hangRealpath = true;
	vi.useFakeTimers();
	const result = canonicalizeFilesystemPath(path, signal);
	// Observe the promise before advancing timers, including intentional error cases.
	result.catch(() => {});
	await vi.advanceTimersByTimeAsync(2001);
	return result;
}

describe("deadline-bounded filesystem resolution (#3404)", () => {
	it("returns an existing path without invoking the fallback", async () => {
		const file = join(root, "file.txt");
		writeFileSync(file, "value");
		expect(await canonicalizeFilesystemPath(file)).toBe(file);
		expect(io.lstatCalls).toEqual([]);
	});

	it("resolves missing descendants through their real parent", async () => {
		expect(await canonicalizeFilesystemPath(join(root, "missing", "new.txt"))).toBe(join(root, "missing", "new.txt"));
	});

	it("resolves a directory junction on Windows and symlink on POSIX", async () => {
		const target = join(root, "target");
		mkdirSync(target);
		symlinkSync(target, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
		expect(await canonicalizeFilesystemPath(join(root, "link", "new.txt"))).toBe(join(target, "new.txt"));
	});

	it.each(["EACCES", "EIO", "ELOOP"])("does not reinterpret %s from realpath as absence", async (code) => {
		io.realpathError = code;
		await expect(canonicalizeFilesystemPath(root)).rejects.toMatchObject({ code });
		expect(io.lstatCalls).toEqual([]);
	});

	it("preserves a missing path when even its root reports absence", async () => {
		io.realpathError = "ENOENT";
		io.lstatError = "ENOENT";
		expect(await canonicalizeFilesystemPath(join(root, "missing"))).toBe(join(root, "missing"));
	});

	it("preserves an lstat error while walking missing parents", async () => {
		io.realpathError = "ENOENT";
		io.lstatError = "EACCES";
		await expect(canonicalizeFilesystemPath(root)).rejects.toMatchObject({ code: "EACCES" });
	});

	it("preserves absolute symlink targets when realpath stalls", async () => {
		const target = join(root, "target");
		mkdirSync(target);
		io.links.set(join(root, "link"), target);
		expect(await fallback(join(root, "link", "new.txt"))).toBe(join(target, "new.txt"));
	});

	it.skipIf(process.platform !== "win32")("keeps the source drive for a drive-rooted symlink target", async () => {
		const target = join(root, "target");
		mkdirSync(target);
		io.links.set(join(root, "link"), `${sep}${target.slice(parse(target).root.length)}`);
		expect(await fallback(join(root, "link", "new.txt"))).toBe(join(target, "new.txt"));
	});

	it("applies dot and parent components after resolving a relative symlink", async () => {
		mkdirSync(join(root, "other", "child"), { recursive: true });
		io.links.set(join(root, "link"), `.${sep}other${sep}child${sep}..${sep}new.txt`);
		expect(await fallback(join(root, "link"))).toBe(join(root, "other", "new.txt"));
	});

	it("keeps parent traversal at the filesystem root", async () => {
		const filesystemRoot = parse(root).root;
		io.links.set(join(root, "link"), `${filesystemRoot}..${sep}.`);
		expect(await fallback(join(root, "link"))).toBe(filesystemRoot);
	});

	it("bounds cyclic symlink traversal", async () => {
		io.links.set(join(root, "loop"), "loop");
		await expect(fallback(join(root, "loop"))).rejects.toMatchObject({ code: "io_error" });
	});

	it.each(["EACCES", "EIO"])("preserves %s from fallback lstat", async (code) => {
		io.lstatError = code;
		await expect(fallback(root)).rejects.toMatchObject({ code });
	});

	it("preserves an unreadable symlink error", async () => {
		io.links.set(join(root, "link"), "target");
		io.readlinkError = "EACCES";
		await expect(fallback(join(root, "link"))).rejects.toMatchObject({ code: "EACCES" });
	});

	it("expires when both realpath and fallback lstat stall", async () => {
		io.hangRealpath = true;
		io.hangLstat = true;
		vi.useFakeTimers();
		const result = canonicalizeFilesystemPath(root);
		const assertion = expect(result).rejects.toMatchObject({
			code: "io_error",
			message: expect.stringContaining("timed out"),
		});
		await vi.advanceTimersByTimeAsync(4001);
		await assertion;
	});

	it("rejects an already-cancelled request without starting I/O", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(canonicalizeFilesystemPath(root, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(io.lstatCalls).toEqual([]);
	});

	it("rejects cancellation immediately and ignores late realpath completion", async () => {
		io.hangRealpath = true;
		const controller = new AbortController();
		const result = canonicalizeFilesystemPath(root, controller.signal);
		const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await assertion;
		io.lateRealpath?.(root);
		await Promise.resolve();
		expect(io.lstatCalls).toEqual([]);
	});

	it("cancels a stalled fallback without waiting for its deadline", async () => {
		io.hangRealpath = true;
		io.hangLstat = true;
		vi.useFakeTimers();
		const controller = new AbortController();
		const result = canonicalizeFilesystemPath(root, controller.signal);
		const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
		await vi.advanceTimersByTimeAsync(2001);
		controller.abort();
		await assertion;
	});

	it("resolves a dangling relative link without lexically collapsing earlier symlinks", async () => {
		mkdirSync(join(root, "elsewhere", "dir"), { recursive: true });
		io.links.set(join(root, "entry"), `jump${sep}..${sep}secret`);
		io.links.set(join(root, "jump"), join(root, "elsewhere", "dir"));
		expect(await fallback(join(root, "entry"))).toBe(join(root, "elsewhere", "secret"));
	});

	it("uses a dangling symlink's target when opening-based lookup reports absence", async () => {
		const link = join(root, "link");
		io.links.set(link, join(root, "target"));
		io.realpathError = "ENOENT";
		io.missing.add(dirname(link));
		await expect(canonicalizeFilesystemPath(link)).resolves.toBe(
			resolve(parse(root).root, root.slice(parse(root).root.length), "target"),
		);
	});
});

describe("deny-wins filesystem policies", () => {
	it("does not install a checker when there are no policies", () => {
		expect(composeFilesystemPolicies([])).toBeUndefined();
	});
	it("returns the first denial and does not call later policies", async () => {
		const later = vi.fn(() => ({ allow: true as const }));
		const checker = composeFilesystemPolicies([
			{ check: () => ({ allow: true }) },
			{ check: () => ({ allow: false, reason: "denied" }) },
			{ check: later },
		]);
		expect(await checker?.({ operation: "read", canonicalPath: root, toolName: "test" })).toEqual({
			allow: false,
			reason: "denied",
		});
		expect(later).not.toHaveBeenCalled();
	});
	it("allows a path when every policy allows it", async () => {
		const checker = composeFilesystemPolicies([{ check: () => ({ allow: true }) }]);
		expect(await checker?.({ operation: "read", canonicalPath: root, toolName: "test" })).toEqual({ allow: true });
	});
});
