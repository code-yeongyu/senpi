import { afterEach, describe, expect, it, vi } from "vitest";
import { isBlockingAutomountPath } from "../src/utils/paths.ts";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	vi.restoreAllMocks();
	vi.resetModules();
});

describe("isBlockingAutomountPath", () => {
	it("flags the bare /home trigger on darwin", () => {
		expect(isBlockingAutomountPath("/home", { platform: "darwin", homeDir: "/Users/person" })).toBe(true);
	});

	it("flags a path under the /home trigger on darwin", () => {
		expect(isBlockingAutomountPath("/home/other/work/run.sh", { platform: "darwin", homeDir: "/Users/person" })).toBe(
			true,
		);
	});

	it("does not flag a normal /Users path on darwin", () => {
		expect(
			isBlockingAutomountPath("/Users/person/project/src", { platform: "darwin", homeDir: "/Users/person" }),
		).toBe(false);
	});

	it("does not flag a name that merely starts with the trigger spelling", () => {
		expect(isBlockingAutomountPath("/homebrew/bin", { platform: "darwin", homeDir: "/Users/person" })).toBe(false);
	});

	it("leaves linux unchanged, where /home is a real directory", () => {
		expect(isBlockingAutomountPath("/home/person/project", { platform: "linux", homeDir: "/home/person" })).toBe(
			false,
		);
		expect(isBlockingAutomountPath("/home", { platform: "linux", homeDir: "/home/person" })).toBe(false);
	});

	it("does not flag the current user's own home when it lives under /home", () => {
		expect(isBlockingAutomountPath("/home/person/project", { platform: "darwin", homeDir: "/home/person" })).toBe(
			false,
		);
		expect(isBlockingAutomountPath("/home/person", { platform: "darwin", homeDir: "/home/person" })).toBe(false);
	});

	it("still flags a sibling account under a /home-rooted home directory", () => {
		expect(isBlockingAutomountPath("/home/other/project", { platform: "darwin", homeDir: "/home/person" })).toBe(
			true,
		);
	});

	it("flags the trigger spelled in another case, which the default macOS filesystem folds", () => {
		expect(isBlockingAutomountPath("/Home/other/work", { platform: "darwin", homeDir: "/Users/person" })).toBe(true);
		expect(isBlockingAutomountPath("/HOME", { platform: "darwin", homeDir: "/Users/person" })).toBe(true);
	});

	it("flags an unnormalized spelling of the trigger", () => {
		expect(isBlockingAutomountPath("/./home/other/work", { platform: "darwin", homeDir: "/Users/person" })).toBe(
			true,
		);
		expect(
			isBlockingAutomountPath("/Users/person/../../home/other", { platform: "darwin", homeDir: "/Users/person" }),
		).toBe(true);
	});
});

describe("canonicalizeFilesystemPath on a wedged automounter", () => {
	it("refuses a /home path on darwin instead of calling realpath or guessing", async () => {
		setPlatform("darwin");
		const realpath = vi.fn(async () => {
			throw new Error("realpath must not be called for an automount trigger path");
		});
		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return { ...actual, realpath };
		});
		const { canonicalizeFilesystemPath } = await import("../src/core/tools/filesystem-policy.ts");

		// Answering with the unresolved path would let /home/<user>/x name a directory that the real
		// /Users/<user>/x path would have failed a containment check on, so resolution fails closed.
		await expect(canonicalizeFilesystemPath("/home/other/work/run.sh")).rejects.toMatchObject({
			code: "unresolvable_automount_path",
		});
		expect(realpath).not.toHaveBeenCalled();
	});

	it("still resolves a normal path through realpath", async () => {
		setPlatform("darwin");
		const realpath = vi.fn(async (target: string) => `${target}-canonical`);
		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return { ...actual, realpath };
		});
		const { canonicalizeFilesystemPath } = await import("../src/core/tools/filesystem-policy.ts");

		expect(await canonicalizeFilesystemPath("/Users/person/project/file.ts")).toBe(
			"/Users/person/project/file.ts-canonical",
		);
		expect(realpath).toHaveBeenCalled();
	});

	it("resolves a /home path through realpath on linux", async () => {
		setPlatform("linux");
		const realpath = vi.fn(async (target: string) => `${target}-canonical`);
		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return { ...actual, realpath };
		});
		const { canonicalizeFilesystemPath } = await import("../src/core/tools/filesystem-policy.ts");

		expect(await canonicalizeFilesystemPath("/home/person/project/file.ts")).toBe(
			"/home/person/project/file.ts-canonical",
		);
		expect(realpath).toHaveBeenCalled();
	});
});

async function withMockedRealpath<T>(realpath: ReturnType<typeof vi.fn>, load: () => Promise<T>): Promise<T> {
	vi.doMock("node:fs/promises", async () => {
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		return { ...actual, realpath };
	});
	return load();
}

describe("the other resolvers on a wedged automounter", () => {
	it("refuses a /home mutation target instead of keying it on an unresolved path", async () => {
		setPlatform("darwin");
		const realpath = vi.fn(async () => {
			throw new Error("realpath must not be called for an automount trigger path");
		});
		const { withFileMutationQueue } = await withMockedRealpath(
			realpath,
			() => import("../src/core/tools/file-mutation-queue.ts"),
		);

		await expect(withFileMutationQueue("/home/other/work/run.sh", async () => "done")).rejects.toMatchObject({
			code: "unresolvable_automount_path",
		});
		expect(realpath).not.toHaveBeenCalled();
	});

	it("keeps resolving a /Users mutation target through realpath", async () => {
		setPlatform("darwin");
		const realpath = vi.fn(async (target: string) => target);
		const { withFileMutationQueue } = await withMockedRealpath(
			realpath,
			() => import("../src/core/tools/file-mutation-queue.ts"),
		);

		await expect(withFileMutationQueue("/Users/person/project/file.ts", async () => "done")).resolves.toBe("done");
		expect(realpath).toHaveBeenCalled();
	});

	it("denies nested AGENTS.md containment for a /home path without resolving it", async () => {
		setPlatform("darwin");
		// The root resolves normally; only the trigger path must never reach realpath.
		const realpath = vi.fn(async (target: string) => {
			if (target.startsWith("/home")) throw new Error("realpath must not be called for an automount trigger path");
			return target;
		});
		const { resolveAndContain } = await withMockedRealpath(
			realpath,
			() => import("../src/core/extensions/builtin/nested-agents-md/core/containment.ts"),
		);

		expect(
			await resolveAndContain({ filePath: "/home/other/work/AGENTS.md", rootDir: "/Users/person/project" }),
		).toBe(null);
		// Only the /Users root is resolved; the trigger path is never handed to realpath.
		expect(realpath).not.toHaveBeenCalledWith("/home/other/work/AGENTS.md");
	});

	it("keeps resolving a /Users containment pair through realpath", async () => {
		setPlatform("darwin");
		const realpath = vi.fn(async (target: string) => target);
		const { resolveAndContain } = await withMockedRealpath(
			realpath,
			() => import("../src/core/extensions/builtin/nested-agents-md/core/containment.ts"),
		);

		expect(
			await resolveAndContain({ filePath: "/Users/person/project/sub/AGENTS.md", rootDir: "/Users/person/project" }),
		).toEqual({ canonicalPath: "/Users/person/project/sub/AGENTS.md", canonicalRoot: "/Users/person/project" });
		expect(realpath).toHaveBeenCalled();
	});
});

describe("grep root resolution on a wedged automounter", () => {
	it("reports a /home search root as missing instead of resolving it", async () => {
		setPlatform("darwin");
		const realpath = vi.fn(async () => {
			throw new Error("realpath must not be called for an automount trigger path");
		});
		const { resolveRoots } = await withMockedRealpath(
			realpath,
			() => import("../src/core/tools/grep/rg/enumerate.ts"),
		);
		const result = { missingPaths: [] as string[] };

		await expect(resolveRoots({ paths: ["/home/other/work"] } as never, result as never)).rejects.toThrow(
			/No search paths exist/,
		);
		expect(result.missingPaths).toEqual(["/home/other/work"]);
		expect(realpath).not.toHaveBeenCalled();
	});
});
