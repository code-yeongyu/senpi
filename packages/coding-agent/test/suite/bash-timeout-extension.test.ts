import { describe, expect, it } from "vitest";
import {
	applyBashTimeout,
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	resolveBashTimeoutDefaults,
} from "../../src/core/extensions/builtin/bash-timeout/timeout.ts";

describe("resolveBashTimeoutDefaults", () => {
	it("ships a 1800s (30 min) default and maximum kill deadline", () => {
		expect(BASH_DEFAULT_TIMEOUT_SECONDS).toBe(1800);
		expect(BASH_MAX_TIMEOUT_SECONDS).toBe(1800);
		expect(resolveBashTimeoutDefaults({})).toEqual({ defaultSeconds: 1800, maxSeconds: 1800 });
	});

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
		const result = resolveBashTimeoutDefaults({ PI_BASH_MAX_TIMEOUT_SECONDS: "3600" });

		expect(result.maxSeconds).toBe(3600);
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
	const defaults = { defaultSeconds: 1800, maxSeconds: 1800 };

	it("injects the default timeout when none is provided", () => {
		const input: { command: string; timeout?: number } = { command: "echo hi" };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "echo hi", timeout: 1800 });
	});

	it("preserves a user-supplied timeout below the maximum", () => {
		const input = { command: "sleep 1", timeout: 30 };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "sleep 1", timeout: 30 });
	});

	it("preserves a user-supplied timeout above the maximum", () => {
		const input = { command: "sleep 99999", timeout: 9999 };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "sleep 99999", timeout: 9999 });
	});

	it("preserves millisecond-style host timeouts instead of capping them as seconds", () => {
		const input = { command: "sleep 30", timeout: 30_000 };

		const result = applyBashTimeout(input, defaults);

		expect(result).toBe(input);
		expect(result.timeout).toBe(30_000);
	});

	it("treats a non-positive timeout as missing and applies default", () => {
		const zero = applyBashTimeout({ command: "noop", timeout: 0 }, defaults);
		const negative = applyBashTimeout({ command: "noop", timeout: -5 }, defaults);

		expect(zero).toEqual({ command: "noop", timeout: 1800 });
		expect(negative).toEqual({ command: "noop", timeout: 1800 });
	});

	it("does not mutate the original input object", () => {
		const input: { command: string; timeout?: number } = { command: "echo hi" };

		applyBashTimeout(input, defaults);

		expect(input.timeout).toBeUndefined();
	});
});
