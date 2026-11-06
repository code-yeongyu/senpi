// senpi#5840: `--hand` and `--headless` select the engine's hand and headless entry points. Both speak their own
// protocol on their own endpoint, so a combination that asks for a prompt, a print run or a text/json stream is
// refused with a diagnostic, and no flag leaves today's parse untouched.
import { describe, expect, it } from "vitest";
import { parseArgs, resolveSessionRuntime } from "../../../src/cli/args.ts";

const errors = (args: string[]) =>
	parseArgs(args)
		.diagnostics.filter((diagnostic) => diagnostic.type === "error")
		.map((diagnostic) => diagnostic.message);

describe("--hand and --headless argument parsing (senpi#5840)", () => {
	it.each([
		{ args: ["--hand"], hand: true, headless: undefined, multiSession: undefined },
		{ args: ["--headless"], hand: undefined, headless: true, multiSession: true },
		{ args: ["--hand", "--mode", "rpc"], hand: true, headless: undefined, multiSession: undefined },
		{ args: ["--headless", "--mode", "rpc", "-e", "ext.ts"], hand: undefined, headless: true, multiSession: true },
		{ args: ["--hand", "--no-skills", "--offline"], hand: true, headless: undefined, multiSession: undefined },
		{ args: ["--headless", "--listen", "unix:///tmp/h.sock"], hand: undefined, headless: true, multiSession: true },
	])("accepts $args as an rpc-mode engine", ({ args, hand, headless, multiSession }) => {
		const parsed = parseArgs(args);
		expect(errors(args)).toEqual([]);
		expect({ mode: parsed.mode, hand: parsed.hand, headless: parsed.headless }).toEqual({
			mode: "rpc",
			hand,
			headless,
		});
		expect(parsed.multiSession).toBe(multiSession);
	});

	it.each([
		{ args: ["--hand", "--headless"], names: ["--hand", "--headless"] },
		{ args: ["--hand", "-p"], names: ["--hand", "--print"] },
		{ args: ["--headless", "hello"], names: ["--headless", "prompt"] },
		{ args: ["--hand", "@notes.md"], names: ["--hand", "@files"] },
		{ args: ["--headless", "-"], names: ["--headless", "stdin"] },
		{ args: ["--hand", "--mode", "json"], names: ["--hand", "--mode json"] },
		{ args: ["--headless", "--mode", "text"], names: ["--headless", "--mode text"] },
		{ args: ["--hand", "--listen", "unix:///tmp/x.sock"], names: ["--hand", "--listen"] },
		{ args: ["--hand", "--multi-session"], names: ["--hand", "--multi-session"] },
	])("refuses $args with an error naming $names", ({ args, names }) => {
		expect(errors(args).some((message) => names.every((name) => message.includes(name)))).toBe(true);
	});

	it("leaves a parse with neither flag exactly as before", () => {
		for (const args of [[], ["-p", "hi"], ["--mode", "json", "x"], ["--mode", "rpc", "--listen", "unix://"]]) {
			const parsed = parseArgs(args);
			expect(parsed.hand).toBeUndefined();
			expect(parsed.headless).toBeUndefined();
			expect(errors(args)).toEqual([]);
		}
		expect(parseArgs([]).mode).toBeUndefined();
	});

	it("runs a headless host's sessions in process, like the socket daemon", () => {
		expect(resolveSessionRuntime(parseArgs(["--headless"]))).toBe("in-process");
		expect(resolveSessionRuntime(parseArgs(["--headless", "--session-runtime", "worker"]))).toBe("worker");
		expect(resolveSessionRuntime(parseArgs(["--mode", "rpc", "--multi-session"]))).toBe("worker");
	});
});
