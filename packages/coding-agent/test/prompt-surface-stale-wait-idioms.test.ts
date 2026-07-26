import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TERMINAL_PROMPT_SECTION } from "../src/core/extensions/builtin/terminal/prompt.ts";
import {
	BASH_OUTPUT_WAIT_REMOVED_GUIDANCE,
	createBashOutputTool,
} from "../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type { TerminalToolContext } from "../src/core/extensions/builtin/terminal/tools/context.ts";

/**
 * Consistency gate: no shipped senpi prompt surface may teach the removed
 * bash_output blocking idiom (`wait_for`). The only tolerated mentions are
 * ghost-guidance lines that state the idiom was removed and redirect to the
 * monitor/notification model. Reintroducing a blocking-wait teaching anywhere
 * in these surfaces fails this gate and names the offending line.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CODING_AGENT_ROOT = join(REPO_ROOT, "packages", "coding-agent");

/** Lines mentioning wait_for are allowed only when they are removal guidance. */
const GHOST_GUIDANCE_MARKER = /removed|no longer/i;

function surfaceLines(name: string, text: string): Array<{ name: string; line: number; text: string }> {
	return text.split("\n").map((line, index) => ({ name, line: index + 1, text: line }));
}

function loadSurfaces(): Array<{ name: string; line: number; text: string }> {
	const stubCtx = {
		manager: { get: () => undefined },
		cwd: process.cwd(),
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => process.env,
	} as unknown as TerminalToolContext;
	const bashOutput = createBashOutputTool(stubCtx);

	return [
		...surfaceLines("terminal/prompt.ts TERMINAL_PROMPT_SECTION", TERMINAL_PROMPT_SECTION),
		...surfaceLines("bash_output tool description", bashOutput.description),
		...surfaceLines("bash_output promptSnippet", bashOutput.promptSnippet ?? ""),
		...surfaceLines(
			"packages/coding-agent/docs/terminal-tools.md",
			readFileSync(join(CODING_AGENT_ROOT, "docs", "terminal-tools.md"), "utf8"),
		),
		...surfaceLines(
			".agents/skills/senpi-qa/SKILL.md",
			readFileSync(join(REPO_ROOT, ".agents", "skills", "senpi-qa", "SKILL.md"), "utf8"),
		),
	];
}

describe("stale wait-idiom consistency gate", () => {
	it("no shipped prompt surface teaches the removed wait_for blocking idiom", () => {
		const violations = loadSurfaces().filter(
			({ text }) => text.includes("wait_for") && !GHOST_GUIDANCE_MARKER.test(text),
		);
		expect(
			violations.map(({ name, line, text }) => `${name}:${line}: ${text.trim()}`),
			"stale wait_for blocking teachings found (non-ghost-guidance mentions)",
		).toEqual([]);
	});

	it("the terminal prompt teaches the monitor/notification model instead", () => {
		expect(TERMINAL_PROMPT_SECTION).toContain("monitor(");
		expect(TERMINAL_PROMPT_SECTION.toLowerCase()).toContain("notification");
		expect(TERMINAL_PROMPT_SECTION).not.toContain("wait_for");
	});

	it("the bash_output tool surface no longer advertises blocking", () => {
		const stubCtx = {
			manager: { get: () => undefined },
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => process.env,
		} as unknown as TerminalToolContext;
		const bashOutput = createBashOutputTool(stubCtx);
		expect(bashOutput.description.toLowerCase()).not.toContain("block until");
		expect(bashOutput.description).not.toContain("wait_for");
		expect(bashOutput.promptSnippet ?? "").not.toContain("wait_for");
	});

	it("the ghost guidance exists so removed-param callers are redirected to monitor", () => {
		expect(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE).toContain("wait_for removed");
		expect(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE).toContain("monitor(");
	});
});
