import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { main } from "../../../src/main.ts";

afterEach(() => vi.restoreAllMocks());

// #3167: a removed integration command must never become a model prompt.
describe("retired app-server invocation", () => {
	it.each([
		{ args: ["app-server"] },
		{ args: ["app-server", "--listen", "stdio://"] },
		{ args: ["app-server", "daemon", "start"] },
		{ args: ["app-server", "--help", "-ne"] },
		{ args: ["--verbose", "app-server"] },
		{ args: ["--no-extensions", "app-server", "daemon", "start"] },
		{ args: ["--provider", "openai", "app-server", "--listen", "stdio://"] },
	])("rejects $args without collecting a prompt", ({ args }) => {
		const parsed = parseArgs(args);
		expect(parsed.diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
		expect(parsed.messages).toEqual([]);
	});

	it.each([{ args: ["app-server", "--help", "-ne"] }, { args: ["--verbose", "app-server", "--help", "-ne"] }])(
		"exits before initializing a model runtime for $args",
		async ({ args }) => {
			const exit = new Error("CLI exited");
			const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
				throw exit;
			});
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const createRuntime = vi.spyOn(ModelRuntime, "create");

			await expect(main(args)).rejects.toBe(exit);

			expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
			expect(errors).toHaveBeenCalled();
			expect(createRuntime).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ args: ["--verbose", "--", "app-server"] },
		{ args: ["-p", "app-server"] },
		{ args: ["--mode", "text", "app-server"] },
		{ args: ["--verbose", "app-server", "--mode", "json"] },
		{ args: ["--verbose", "app-server", "-p"] },
		{ args: ["--verbose", "explain", "app-server"] },
	])("keeps ordinary prompt arguments $args", ({ args }) => {
		const parsed = parseArgs(args);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.messages).toEqual(args.includes("explain") ? ["explain", "app-server"] : ["app-server"]);
	});

	it("does not confuse a flag value with the retired command", () => {
		const parsed = parseArgs(["--system-prompt", "app-server", "hello"]);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.systemPrompt).toBe("app-server");
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("keeps explicit prompt text and Native RPC arguments usable", () => {
		const prompt = parseArgs(["-p", "--", "app-server"]);
		expect(prompt.diagnostics).toEqual([]);
		expect(prompt.messages).toEqual(["app-server"]);

		const rpc = parseArgs(["--mode", "rpc", "--multi-session"]);
		expect(rpc.diagnostics).toEqual([]);
		expect(rpc.mode).toBe("rpc");
		expect(rpc.multiSession).toBe(true);
	});
});
