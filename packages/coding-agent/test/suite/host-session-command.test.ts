import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHostSessionArgs, runHostSessionCommand } from "../../src/cli/host-session-command.ts";
import * as runner from "../../src/modes/rpc/host-session-runner.ts";

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	writeSync: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

// #3073: pin the public argv and JSON/exit contract, including verbatim prompt files.
describe("host session command", () => {
	it.each([
		[
			["open", "--cwd", ".", "--model", "anthropic/mock"],
			{ action: "open", cwd: resolve("."), model: { provider: "anthropic", id: "mock" } },
		],
		[["close", "rpc-1"], { action: "close", ref: "rpc-1" }],
		[
			["model", "rpc-1", "anthropic/mock"],
			{ action: "model", ref: "rpc-1", model: { provider: "anthropic", id: "mock" } },
		],
		[["prompt", "rpc-1", "hello"], { action: "prompt", ref: "rpc-1", text: "hello" }],
		[["steer", "rpc-1", "hello"], { action: "steer", ref: "rpc-1", text: "hello" }],
		[["abort", "rpc-1"], { action: "abort", ref: "rpc-1" }],
		[
			["read", "rpc-1", "--tail", "2", "--since", "entry"],
			{ action: "read", ref: "rpc-1", tail: 2, since: "entry", messages: false },
		],
		[["read", "rpc-1", "--messages"], { action: "read", ref: "rpc-1", messages: true }],
		[["state", "rpc-1"], { action: "state", ref: "rpc-1" }],
		[["list"], { action: "list" }],
		[["wait", "rpc-1"], { action: "wait", ref: "rpc-1", until: "idle", timeoutMs: 600000 }],
		[
			["wait", "rpc-1", "--until", "done", "--timeout", "0"],
			{ action: "wait", ref: "rpc-1", until: "done", timeoutMs: 0 },
		],
	])("parses %j", (args, command) => {
		expect(parseHostSessionArgs([...args, "--socket", "/socket", "--json"])).toMatchObject({
			command,
			socket: "/socket",
		});
	});

	it.each(
		[
			[],
			["bogus"],
			["open"],
			["open", "--cwd", ".", "--model", "foo"],
			["model", "ref", "p/a/b"],
			["read", "ref", "--tail", "0"],
			["read", "ref", "--tail", "1.2"],
			["wait", "ref", "--until", "later"],
			["wait", "ref", "--timeout", "-1"],
			["list", "--bogus"],
			["state", "ref", "extra"],
		].map((args) => [args]),
	)("rejects invalid argv %j", (args) => {
		expect(typeof parseHostSessionArgs(args)).toBe("string");
	});

	it("returns usage with one stdout JSON line and stderr help", async () => {
		const stdout = vi.spyOn(fs, "writeSync").mockReturnValue(0);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(await runHostSessionCommand([])).toBe(2);
		expect(stdout).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(stdout.mock.calls[0][1]))).toMatchObject({ action: "error", reason: "usage" });
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("usage:"));
	});

	it("reports an unreadable prompt file as usage", async () => {
		const stdout = vi.spyOn(fs, "writeSync").mockReturnValue(0);
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(await runHostSessionCommand(["prompt", "ref", "@/nonexistent/host-session-prompt"])).toBe(2);
		expect(JSON.parse(String(stdout.mock.calls[0][1]))).toMatchObject({ reason: "prompt_file_unreadable" });
	});

	it("passes BOM-stripped file bytes without an attachment wrapper", async () => {
		const dir = fs.mkdtempSync(join(tmpdir(), "hs-prompt-"));
		try {
			const file = join(dir, "prompt.txt");
			fs.writeFileSync(file, "\uFEFFhello\n\n");
			const run = vi
				.spyOn(runner, "runHostSessionRequest")
				.mockResolvedValue({ exitCode: 0, payload: { action: "prompt" } });
			vi.spyOn(fs, "writeSync").mockReturnValue(0);
			expect(await runHostSessionCommand(["prompt", "ref", `@${file}`])).toBe(0);
			expect(run).toHaveBeenCalledWith(expect.objectContaining({ text: "hello\n\n" }));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
