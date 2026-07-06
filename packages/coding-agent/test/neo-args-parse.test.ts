import { describe, expect, test } from "vitest";
import { type Args, parseArgs } from "../src/cli/args.ts";

/**
 * Pin the classic parser semantics. These EXPECTED values are written from the
 * pre-change parser (main baseline) and must stay byte-identical after the --neo
 * flag is added — no classic invocation may parse differently. If a future edit
 * changes how any of these classic flags parse, this test fails.
 */
type PartialArgs = Partial<Args>;

function subset(parsed: Args, keys: readonly (keyof Args)[]): PartialArgs {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = parsed[key];
		if (value !== undefined) {
			out[key as string] = value;
		}
	}
	return out as PartialArgs;
}

describe("classic parser semantics are byte-identical (no --neo present)", () => {
	test.each<[string, string[], PartialArgs]>([
		["provider+model", ["--provider", "openai", "--model", "gpt-4o"], { provider: "openai", model: "gpt-4o" }],
		["print with message", ["-p", "hi"], { print: true, messages: ["hi"] }],
		["models split+trim", ["--models", "a, b ,c"], { models: ["a", "b", "c"] }],
		["tools", ["--tools", "read,bash"], { tools: ["read", "bash"] }],
		["file + message", ["@a.md", "explain"], { fileArgs: ["a.md"], messages: ["explain"] }],
		["approve", ["--approve"], { projectTrustOverride: true }],
		["no-approve", ["--no-approve"], { projectTrustOverride: false }],
		["thinking", ["--thinking", "high"], { thinking: "high" }],
		["unknown flag captured", ["--plan"], {}],
	])("%s", (_label, argv, expected) => {
		const parsed = parseArgs(argv);
		expect(subset(parsed, Object.keys(expected) as (keyof Args)[])).toEqual(expected);
	});

	test("unknown flag still routed to unknownFlags (extension flag channel intact)", () => {
		const parsed = parseArgs(["--plan"]);
		expect(parsed.unknownFlags.get("plan")).toBe(true);
	});

	test("a genuinely unknown short option still reports an error diagnostic", () => {
		const parsed = parseArgs(["-zzz"]);
		expect(parsed.diagnostics).toContainEqual({ type: "error", message: "Unknown option: -zzz" });
	});
});

describe("--neo flag parsing", () => {
	test("--neo is now a recognized flag, not an 'Unknown option' error", () => {
		const parsed = parseArgs(["--neo"]);
		expect(parsed.neo).toBe(true);
		expect(parsed.diagnostics).toEqual([]);
	});

	test("--neo-isolated implies neo and sets neoIsolated", () => {
		const parsed = parseArgs(["--neo-isolated"]);
		expect(parsed.neo).toBe(true);
		expect(parsed.neoIsolated).toBe(true);
		expect(parsed.diagnostics).toEqual([]);
	});

	test("--neo-bin captures a dev override path", () => {
		const parsed = parseArgs(["--neo", "--neo-bin", "/tmp/dev-neo"]);
		expect(parsed.neo).toBe(true);
		expect(parsed.neoBin).toBe("/tmp/dev-neo");
	});

	test("--neo coexists with runtime flags without swallowing them", () => {
		const parsed = parseArgs(["--neo", "--model", "gpt-4o", "hello"]);
		expect(parsed.neo).toBe(true);
		expect(parsed.model).toBe("gpt-4o");
		expect(parsed.messages).toEqual(["hello"]);
	});
});
