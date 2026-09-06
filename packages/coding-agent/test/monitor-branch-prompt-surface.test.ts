import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTerminalPromptSection } from "../src/core/extensions/builtin/terminal/prompt.ts";
import type { TerminalToolContext } from "../src/core/extensions/builtin/terminal/tools/context.ts";
import { createMonitorTool, monitorSchema } from "../src/core/extensions/builtin/terminal/tools/monitor.ts";

/**
 * Coverage gate for the monitor tool's create branches.
 *
 * `monitor` accepts `command` XOR `path`, enforced at runtime in `execute`
 * because the schema is a flat object with no root union and no required
 * fields. That makes the shipped prose the only place a caller can learn a
 * branch exists: when the file branch shipped in the schema without reaching
 * `prompt.ts`, the tool description, or the docs, agents read the command-only
 * signature literally, concluded monitor could not be registered, and fell
 * back to a plain background session.
 *
 * The assertions key on schema property names and on each branch's call shape,
 * never on surrounding prose, so the surfaces stay free to be reworded. Bare
 * name presence is not enough on its own: `path` survives in an XOR sentence
 * and `filter`/`persistent` survive in the file branch's negation, so a branch
 * could be deleted while every name still appeared somewhere.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CODING_AGENT_ROOT = join(REPO_ROOT, "packages", "coding-agent");

const CREATE_BRANCH_PROPERTIES = ["command", "path", "event", "filter", "persistent"] as const;

/** Both eval-only renderings must teach both branches; neither may lose one to a call-form rewrite. */
const PROMPT_SECTIONS = [true, false].map((evalOnly) => ({
	label: `evalOnly=${evalOnly}`,
	text: buildTerminalPromptSection({ evalOnly }),
}));

/** A branch is documented only when its own call shape is shown, not merely its property names. */
const BRANCH_CALL_SHAPES = [/monitor\(\{[^}]*\bcommand\b[^}]*\}\)/, /monitor\(\{[^}]*\bpath\b[^}]*\}\)/] as const;

function stubTerminalCtx(): TerminalToolContext {
	return {
		manager: { get: () => undefined },
		cwd: process.cwd(),
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => process.env,
	} as unknown as TerminalToolContext;
}

function monitorToolSurface(): string {
	const tool = createMonitorTool(stubTerminalCtx());
	return [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])].join("\n");
}

function terminalToolsDoc(): string {
	return readFileSync(join(CODING_AGENT_ROOT, "docs", "terminal-tools.md"), "utf8");
}

describe("monitor create-branch prompt coverage gate", () => {
	it("every create-branch schema property is named by the tool's own surface", () => {
		const surface = monitorToolSurface();
		const missing = CREATE_BRANCH_PROPERTIES.filter((property) => !surface.includes(property));
		expect(missing, "monitor schema properties absent from its description/snippet/guidelines").toEqual([]);
	});

	it("the terminal prompt section shows a call shape for each create branch", () => {
		for (const { label, text } of PROMPT_SECTIONS) {
			const missing = BRANCH_CALL_SHAPES.filter((shape) => !shape.test(text));
			expect(missing.map(String), `${label}: a monitor branch has no call shape in the prompt section`).toEqual([]);
			expect(text, label).toContain("event");
		}
	});

	it("the file branch's create-on-appearance limit is stated wherever the file branch is taught", () => {
		for (const [name, surface] of [
			...PROMPT_SECTIONS.map(({ label, text }) => [`prompt section ${label}`, text] as const),
			["tool surface", monitorToolSurface()],
			["terminal-tools doc", terminalToolsDoc()],
		] as const) {
			expect(surface, `${name} teaches the file branch without the create-on-appearance caveat`).toMatch(
				/fires only/,
			);
		}
	});

	it("the shipped terminal-tools doc shows a file-branch recipe", () => {
		expect(terminalToolsDoc()).toMatch(/path:\s*"/);
	});

	it("the XOR rule is stated on the tool surface and in the prompt, not only in a runtime error", () => {
		expect(monitorToolSurface()).toContain("XOR");
		for (const { label, text } of PROMPT_SECTIONS) {
			expect(text, label).toContain("XOR");
		}
	});

	it("no create-branch property is advertised as unconditionally required", () => {
		const properties = monitorSchema.properties as Record<string, { description?: string }>;
		const overclaimed = CREATE_BRANCH_PROPERTIES.filter((property) => {
			const description = properties[property]?.description ?? "";
			return /\(required\)/.test(description);
		});
		expect(
			overclaimed,
			"a branch-scoped property claims plain '(required)'; label the branch it belongs to instead",
		).toEqual([]);
	});

	it("keeps every create-branch property optional so neither branch is schema-forced", () => {
		const required = (monitorSchema as { required?: readonly string[] }).required ?? [];
		expect(required).toEqual([]);
	});
});
