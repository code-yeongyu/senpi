import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HOST_COMMAND_ARGV, SCHEDULE_COMMAND_ARGV } from "../src/cli/deferred-commands.ts";
import { enableStartupCompileCache } from "../src/compile-cache.ts";
import type { PackageCommand } from "../src/package-manager-cli.ts";

const { enableCompileCache } = vi.hoisted(() => ({
	enableCompileCache: vi.fn(() => ({ directory: "/compile-cache" })),
}));
vi.mock("node:module", () => ({ enableCompileCache }));
const originalArgv = process.argv;

beforeEach(() => {
	vi.stubEnv("NODE_COMPILE_CACHE", undefined);
	enableCompileCache.mockClear();
});

afterEach(() => {
	process.argv = originalArgv;
	vi.unstubAllEnvs();
});

describe("startup compile cache invocation decision", () => {
	test.each(
		[
			["--help"],
			["-h"],
			["--version"],
			["-v"],
			["--provider", "openai-codex", "--version"],
			["--provider", "openai-codex", "-v"],
			["--help", "--no-extensions"],
			["--help", "--mode", "json"],
			["-p", "--help"],
			["--list-models"],
			["--list-models", "gpt"],
			["--list-tips"],
			["--export", "session.jsonl"],
			["uninstall", "extension"],
			[HOST_COMMAND_ARGV, "status"],
			[SCHEDULE_COMMAND_ARGV, "list"],
			[SCHEDULE_COMMAND_ARGV, "run"],
			[SCHEDULE_COMMAND_ARGV, "run", "--exec", "--watch"],
			["config", "--help"],
		].map((args) => ({ args })),
	)("does not enable or publish a cache for print-then-exit argv $args", async ({ args }) => {
		process.argv = ["node", "cli.ts", ...args];

		await enableStartupCompileCache();

		expect(enableCompileCache).not.toHaveBeenCalled();
		expect(process.env.NODE_COMPILE_CACHE).toBeUndefined();
	});

	// #3166: every deferred package verb must skip caching, including future union members.
	test.each(
		Object.entries({
			install: ["extension"],
			remove: ["extension"],
			update: [],
			list: [],
		} satisfies Record<PackageCommand, string[]>),
	)("skips caching when the deferred package command is %s", async (command, rest) => {
		process.argv = ["node", "cli.ts", command, ...rest];

		await enableStartupCompileCache();

		expect(enableCompileCache).not.toHaveBeenCalled();
		expect(process.env.NODE_COMPILE_CACHE).toBeUndefined();
	});

	test.each(
		[
			[],
			["-p", "hello"],
			["--mode", "rpc"],
			["--mode", "json", "-p", "hello"],
			["config"],
			["--", "--list-tips"],
			["--system-prompt", "--list-tips"],
			["--append-system-prompt", "--help"],
			["--extension", "--list-models"],
			["--name", "--export"],
			["--provider", "openai-codex", "--help"],
			["--provider", "openai-codex", "-h"],
			[SCHEDULE_COMMAND_ARGV, "run", "--watch"],
			[SCHEDULE_COMMAND_ARGV, "run", "--exec", "echo event", "--watch"],
			["--mode", "rpc", "--multi-session", "--help"],
			["--mode", "rpc", "--listen", "stdio://", "--help"],
		].map((args) => ({ args })),
	)("enables and publishes a cache for session argv $args", async ({ args }) => {
		process.argv = ["node", "cli.ts", ...args];

		await enableStartupCompileCache();

		expect(enableCompileCache).toHaveBeenCalledOnce();
		expect(process.env.NODE_COMPILE_CACHE).toBe("/compile-cache");
	});
});
