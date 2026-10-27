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
		expect(isBlockingAutomountPath("/Users/person/project/src", { platform: "darwin", homeDir: "/Users/person" })).toBe(
			false,
		);
	});

	it("does not flag a name that merely starts with the trigger spelling", () => {
		expect(isBlockingAutomountPath("/homebrew/bin", { platform: "darwin", homeDir: "/Users/person" })).toBe(false);
	});

	it("leaves linux unchanged, where /home is a real directory", () => {
		expect(isBlockingAutomountPath("/home/person/project", { platform: "linux", homeDir: "/home/person" })).toBe(false);
		expect(isBlockingAutomountPath("/home", { platform: "linux", homeDir: "/home/person" })).toBe(false);
	});

	it("does not flag the current user's own home when it lives under /home", () => {
		expect(isBlockingAutomountPath("/home/person/project", { platform: "darwin", homeDir: "/home/person" })).toBe(false);
		expect(isBlockingAutomountPath("/home/person", { platform: "darwin", homeDir: "/home/person" })).toBe(false);
	});

	it("still flags a sibling account under a /home-rooted home directory", () => {
		expect(isBlockingAutomountPath("/home/other/project", { platform: "darwin", homeDir: "/home/person" })).toBe(true);
	});
});

describe("canonicalizeFilesystemPath on a wedged automounter", () => {
	it("never calls realpath for a /home path on darwin", async () => {
		setPlatform("darwin");
		const realpath = vi.fn(async () => {
			throw new Error("realpath must not be called for an automount trigger path");
		});
		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return { ...actual, realpath };
		});
		const { canonicalizeFilesystemPath } = await import("../src/core/tools/filesystem-policy.ts");

		expect(await canonicalizeFilesystemPath("/home/other/work/run.sh")).toBe("/home/other/work/run.sh");
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
