/**
 * Regression test: `senpi --neo` MUST forward neo-TUI flags from the
 * caller to the Rust `senpi-neo-tui` binary via the `--` sentinel.
 *
 * Without the sentinel split, the senpi argparser eats `--theme`,
 * `--demo`, etc. and either errors out (for unknown Rust-only flags)
 * or treats them as senpi-side options, so the neo TUI never sees its own
 * flags and `senpi --neo -- --theme dracula` becomes a lie in the docs.
 *
 * Source of truth: {@link splitNeoArgs} in
 * `packages/coding-agent/src/modes/neo-mode.ts`.
 */

import { describe, expect, test } from "vitest";
import { splitNeoArgs } from "../../../src/modes/neo-mode.ts";

describe("neo-mode arg forwarding via `--` sentinel", () => {
	test("with no sentinel, every non-`--neo` arg goes to the senpi backend", () => {
		const { backend, neo } = splitNeoArgs(["--neo", "--provider", "anthropic", "--model", "sonnet"]);
		expect(neo).toEqual([]);
		expect(backend).toEqual(["--provider", "anthropic", "--model", "sonnet"]);
	});

	test("args after `--` flow to the neo TUI binary verbatim", () => {
		const { backend, neo } = splitNeoArgs(["--neo", "--", "--theme", "dracula", "--demo"]);
		expect(neo).toEqual(["--theme", "dracula", "--demo"]);
		// `--neo` is filtered, sentinel is dropped, nothing else before it.
		expect(backend).toEqual([]);
	});

	test("mixed: backend flags before, neo flags after the sentinel", () => {
		const { backend, neo } = splitNeoArgs([
			"--neo",
			"--provider",
			"anthropic",
			"--",
			"--theme",
			"dracula",
			"--demo-seconds",
			"3",
		]);
		expect(backend).toEqual(["--provider", "anthropic"]);
		expect(neo).toEqual(["--theme", "dracula", "--demo-seconds", "3"]);
	});

	test("`--list-themes` is forwarded so users can probe the bundle", () => {
		const { neo } = splitNeoArgs(["--neo", "--", "--list-themes"]);
		expect(neo).toEqual(["--list-themes"]);
	});

	test("empty argv after sentinel is allowed (sentinel-only is a no-op)", () => {
		const { backend, neo } = splitNeoArgs(["--neo", "--"]);
		expect(backend).toEqual([]);
		expect(neo).toEqual([]);
	});

	test("`--neo` does not need to be the first arg", () => {
		const { backend, neo } = splitNeoArgs(["--provider", "openai", "--neo", "--", "--theme", "nord"]);
		expect(backend).toEqual(["--provider", "openai"]);
		expect(neo).toEqual(["--theme", "nord"]);
	});
});
