import { describe, expect, it } from "vitest";
import {
	applyBashTimeout,
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	buildBashTimeoutPrompt,
	resolveBashTimeoutDefaults,
} from "../../src/core/extensions/builtin/bash-timeout.js";

describe("resolveBashTimeoutDefaults", () => {
	it("returns built-in defaults when env vars are absent", () => {
		const result = resolveBashTimeoutDefaults({});

		expect(result.defaultSeconds).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
		expect(result.maxSeconds).toBe(BASH_MAX_TIMEOUT_SECONDS);
	});

	it("reads PI_BASH_DEFAULT_TIMEOUT_SECONDS from env", () => {
		const result = resolveBashTimeoutDefaults({ PI_BASH_DEFAULT_TIMEOUT_SECONDS: "30" });

		expect(result.defaultSeconds).toBe(30);
	});

	it("reads PI_BASH_MAX_TIMEOUT_SECONDS from env", () => {
		const result = resolveBashTimeoutDefaults({ PI_BASH_MAX_TIMEOUT_SECONDS: "900" });

		expect(result.maxSeconds).toBe(900);
	});

	it("ignores PI_BASH_DEFAULT_TIMEOUT_SECONDS when value is not a positive integer", () => {
		const garbage = resolveBashTimeoutDefaults({ PI_BASH_DEFAULT_TIMEOUT_SECONDS: "garbage" });
		const zero = resolveBashTimeoutDefaults({ PI_BASH_DEFAULT_TIMEOUT_SECONDS: "0" });
		const negative = resolveBashTimeoutDefaults({ PI_BASH_DEFAULT_TIMEOUT_SECONDS: "-1" });

		expect(garbage.defaultSeconds).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
		expect(zero.defaultSeconds).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
		expect(negative.defaultSeconds).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
	});

	it("ignores PI_BASH_MAX_TIMEOUT_SECONDS when value is not a positive integer", () => {
		const garbage = resolveBashTimeoutDefaults({ PI_BASH_MAX_TIMEOUT_SECONDS: "garbage" });
		const zero = resolveBashTimeoutDefaults({ PI_BASH_MAX_TIMEOUT_SECONDS: "0" });

		expect(garbage.maxSeconds).toBe(BASH_MAX_TIMEOUT_SECONDS);
		expect(zero.maxSeconds).toBe(BASH_MAX_TIMEOUT_SECONDS);
	});

	it("ensures max is at least as large as default when env values would invert that order", () => {
		const result = resolveBashTimeoutDefaults({
			PI_BASH_DEFAULT_TIMEOUT_SECONDS: "500",
			PI_BASH_MAX_TIMEOUT_SECONDS: "100",
		});

		expect(result.defaultSeconds).toBe(500);
		expect(result.maxSeconds).toBe(500);
	});
});

describe("applyBashTimeout", () => {
	const defaults = { defaultSeconds: 120, maxSeconds: 600 };

	it("injects the default timeout when none is provided", () => {
		const input: { command: string; timeout?: number } = { command: "echo hi" };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "echo hi", timeout: 120 });
	});

	it("preserves a user-supplied timeout below the maximum", () => {
		const input = { command: "sleep 1", timeout: 30 };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "sleep 1", timeout: 30 });
	});

	it("caps a user-supplied timeout above the maximum", () => {
		const input = { command: "sleep 99999", timeout: 9999 };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "sleep 99999", timeout: 600 });
	});

	it("treats a non-positive timeout as missing and applies default", () => {
		const zero = applyBashTimeout({ command: "noop", timeout: 0 }, defaults);
		const negative = applyBashTimeout({ command: "noop", timeout: -5 }, defaults);

		expect(zero).toEqual({ command: "noop", timeout: 120 });
		expect(negative).toEqual({ command: "noop", timeout: 120 });
	});

	it("does not mutate the original input object", () => {
		const input: { command: string; timeout?: number } = { command: "echo hi" };

		applyBashTimeout(input, defaults);

		expect(input.timeout).toBeUndefined();
	});
});

describe("buildBashTimeoutPrompt", () => {
	it("includes the resolved default and max in the prompt rider", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 600 });

		expect(prompt).toContain("Default timeout: 120s (2 min)");
		expect(prompt).toContain("Maximum timeout: 600s (10 min)");
	});

	it("falls back to seconds for non-minute-aligned values", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 45, maxSeconds: 90 });

		expect(prompt).toContain("Default timeout: 45s (45s)");
		expect(prompt).toContain("Maximum timeout: 90s (90s)");
	});

	it("instructs the model to set timeout explicitly for long-running commands", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 600 });

		expect(prompt).toMatch(/long-running commands/i);
		expect(prompt).toMatch(/explicit `timeout`/i);
	});

	it("references tmux as the escape hatch for very long workloads", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 600 });

		expect(prompt).toContain("tmux");
	});
});
