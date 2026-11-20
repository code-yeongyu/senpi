import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { main } from "../../../src/main.ts";

afterEach(() => vi.restoreAllMocks());

// #3521: boolean extension flags before the prompt must not swallow the prompt,
// and print mode without a prompt must exit non-zero with a usage message.
describe("issue #3521: boolean extension flags and print mode empty prompt", () => {
	it("preserves prompt when boolean extension flags precede prompt", () => {
		const parsed = parseArgs([
			"-p",
			"--provider",
			"anthropic",
			"--model",
			"claude-3-5-sonnet",
			"--no-model-fallback",
			"Reply with OK.",
		]);
		expect(parsed.print).toBe(true);
		expect(parsed.provider).toBe("anthropic");
		expect(parsed.model).toBe("claude-3-5-sonnet");
		expect(parsed.messages).toEqual(["Reply with OK."]);
		expect(parsed.unknownFlags.get("no-model-fallback")).toBe(true);
	});

	it("preserves prompt with other boolean extension flags like --no-ask-user and --pi-rules-disabled", () => {
		const parsed1 = parseArgs(["-p", "--no-ask-user", "Do something."]);
		expect(parsed1.messages).toEqual(["Do something."]);
		expect(parsed1.unknownFlags.get("no-ask-user")).toBe(true);

		const parsed2 = parseArgs(["-p", "--pi-rules-disabled", "Review code."]);
		expect(parsed2.messages).toEqual(["Review code."]);
		expect(parsed2.unknownFlags.get("pi-rules-disabled")).toBe(true);
	});

	it("supports custom boolean flags passed in parseArgs options", () => {
		const parsed = parseArgs(["-p", "--custom-flag", "Process this."], {
			booleanFlags: ["custom-flag"],
		});
		expect(parsed.messages).toEqual(["Process this."]);
		expect(parsed.unknownFlags.get("custom-flag")).toBe(true);
	});

	it("exits non-zero with a usage message when print mode is called with an empty prompt", async () => {
		const exit = new Error("CLI exited");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw exit;
		});
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...msg: unknown[]) => {
			errors.push(msg.map(String).join(" "));
		});
		vi.spyOn(process.stdin, "isTTY", "get").mockReturnValue(true);

		await expect(main(["-p", "--no-extensions"])).rejects.toBe(exit);

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errors.some((e) => e.includes("Print mode requires a prompt"))).toBe(true);
	});
});
