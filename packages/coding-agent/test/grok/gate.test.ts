import { describe, expect, it, vi } from "vitest";
import { parseArgs, printHelp } from "../../src/cli/args.ts";
import { ENV_ENABLE_GROK_NEO, isGrokNeoEnabled } from "../../src/cli/grok-neo-gate.ts";

describe("grok-neo feature gate", () => {
	it("is disabled by default and only accepts documented truthy values", () => {
		expect(ENV_ENABLE_GROK_NEO).toBe("SENPI_ENABLE_GROK_NEO");
		expect(isGrokNeoEnabled({})).toBe(false);
		expect(isGrokNeoEnabled({ [ENV_ENABLE_GROK_NEO]: "0" })).toBe(false);
		expect(isGrokNeoEnabled({ [ENV_ENABLE_GROK_NEO]: " true " })).toBe(true);
		expect(isGrokNeoEnabled({ [ENV_ENABLE_GROK_NEO]: "YES" })).toBe(true);
	});

	it("keeps --grok-neo unknown and hidden from help while disabled", () => {
		const parsed = parseArgs(["--grok-neo"], { grokNeoEnabled: false });
		expect(parsed.grokNeo).toBeUndefined();
		expect(parsed.unknownFlags.get("grok-neo")).toBe(true);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp(undefined, false);
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain("--grok-neo");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("parses and advertises --grok-neo only while enabled", () => {
		const parsed = parseArgs(["--grok-neo"], { grokNeoEnabled: true });
		expect(parsed.grokNeo).toBe(true);
		expect(parsed.unknownFlags.has("grok-neo")).toBe(false);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp(undefined, true);
			const help = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(help).toContain("--grok-neo");
			expect(help).toMatch(/--grok-neo.*experimental/i);
		} finally {
			logSpy.mockRestore();
		}
	});
});
