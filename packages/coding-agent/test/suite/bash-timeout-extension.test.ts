import { describe, expect, it } from "vitest";
import {
	applyBashTimeout,
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	buildBashTimeoutPrompt,
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

describe("buildBashTimeoutPrompt", () => {
	const SHIPPED_POLICY =
		"\n## Bash Tool Timeout Policy\n\nThe `bash` tool's `timeout` parameter is the process kill deadline, not how long you wait for output: the command is killed when it reaches the deadline.\n\n- Default timeout: 1800s (30 min). Applied automatically when you do not set `timeout`.\n- Recommended maximum timeout: 1800s (30 min). Explicit `timeout` values are preserved because different hosts may use different timeout units.\n- Foreground blocking stops at the ~60s window. A command still running then auto-detaches alive to a background session with a `bash_id` and keeps running until it exits, hits the kill deadline, or is stopped with `kill_bash`.\n- Completion arrives automatically as a notification carrying the exit status and output tail, so end your turn rather than poll. Use `bash_output` only for a midpoint peek.\n- Waiting on an observable condition (a log line, a CI check, a server coming up) belongs to `monitor({command, filter})`, never a foreground `sleep` or poll loop.\n- Sessions started with `run_in_background: true` ignore `timeout` and live until exit or `kill_bash`.\n";

	it("is byte-identical to the shipped kill-deadline policy", () => {
		expect(buildBashTimeoutPrompt({ defaultSeconds: 1800, maxSeconds: 1800 }, 60)).toBe(SHIPPED_POLICY);
	});

	it("states that timeout is the process kill deadline, not the wait budget", () => {
		const prompt = buildBashTimeoutPrompt(resolveBashTimeoutDefaults({}), 60);

		expect(prompt).toContain("## Bash Tool Timeout Policy");
		expect(prompt).toContain("process kill deadline");
		expect(prompt).toContain("not how long you wait");
		expect(prompt).toContain("Default timeout: 1800s (30 min)");
	});

	it("contains the auto-detach and monitor guidance and never mentions the prompt cache", () => {
		const prompt = buildBashTimeoutPrompt(resolveBashTimeoutDefaults({}), 60);

		expect(prompt).toContain("~60s window");
		expect(prompt).toContain("auto-detaches alive");
		expect(prompt).toContain("bash_id");
		expect(prompt).toContain("exit status and output tail");
		expect(prompt).toContain("end your turn rather than poll");
		expect(prompt).toContain("bash_output` only for a midpoint peek");
		expect(prompt).toContain("monitor({command, filter})");
		expect(prompt).toContain("run_in_background: true");
		expect(prompt).toContain("kill_bash");
		expect(prompt).not.toContain("tmux");
		expect(prompt.toLowerCase()).not.toContain("prompt cache");
	});

	it("falls back to seconds for non-minute-aligned values", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 45, maxSeconds: 90 });

		expect(prompt).toContain("Default timeout: 45s (45s)");
		expect(prompt).toContain("Recommended maximum timeout: 90s (90s)");
	});
});
