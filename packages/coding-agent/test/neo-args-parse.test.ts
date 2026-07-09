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

describe("--neo flag parsing (gate enabled)", () => {
	test("--neo is a recognized flag when neo is enabled, not an 'Unknown option' error", () => {
		const parsed = parseArgs(["--neo"], { neoEnabled: true });
		expect(parsed.neo).toBe(true);
		expect(parsed.diagnostics).toEqual([]);
	});

	test("--neo-isolated implies neo and sets neoIsolated", () => {
		const parsed = parseArgs(["--neo-isolated"], { neoEnabled: true });
		expect(parsed.neo).toBe(true);
		expect(parsed.neoIsolated).toBe(true);
		expect(parsed.diagnostics).toEqual([]);
	});

	test("--neo-bin captures a dev override path", () => {
		const parsed = parseArgs(["--neo", "--neo-bin", "/tmp/dev-neo"], { neoEnabled: true });
		expect(parsed.neo).toBe(true);
		expect(parsed.neoBin).toBe("/tmp/dev-neo");
	});

	test("--neo coexists with runtime flags without swallowing them", () => {
		const parsed = parseArgs(["--neo", "--model", "gpt-4o", "hello"], { neoEnabled: true });
		expect(parsed.neo).toBe(true);
		expect(parsed.model).toBe("gpt-4o");
		expect(parsed.messages).toEqual(["hello"]);
	});
});

describe("--neo flags are absent when the gate is off (default)", () => {
	test("--neo falls through to the unknown-flag channel and never dispatches", () => {
		const parsed = parseArgs(["--neo"], { neoEnabled: false });
		expect(parsed.neo).toBeUndefined();
		expect(parsed.unknownFlags.get("neo")).toBe(true);
		expect(parsed.diagnostics).toEqual([]);
	});

	test("--neo-isolated / --register are unknown flags and set no neo state", () => {
		const parsed = parseArgs(["--neo-isolated", "--register"], { neoEnabled: false });
		expect(parsed.neo).toBeUndefined();
		expect(parsed.neoIsolated).toBeUndefined();
		expect(parsed.neoRegister).toBeUndefined();
		expect(parsed.unknownFlags.get("neo-isolated")).toBe(true);
		expect(parsed.unknownFlags.get("register")).toBe(true);
	});

	test("--listen consumes its value as an unknown flag, not neoListen", () => {
		const parsed = parseArgs(["--listen", "/tmp/s.sock"], { neoEnabled: false });
		expect(parsed.neoListen).toBeUndefined();
		expect(parsed.unknownFlags.get("listen")).toBe("/tmp/s.sock");
	});

	test("classic runtime flags still parse normally alongside a stray --neo", () => {
		const parsed = parseArgs(["--neo", "--model", "gpt-4o", "hello"], { neoEnabled: false });
		expect(parsed.neo).toBeUndefined();
		expect(parsed.model).toBe("gpt-4o");
		expect(parsed.messages).toEqual(["hello"]);
	});
});
