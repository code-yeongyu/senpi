import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../../src/core/extensions/builtin/agent-system/builtin-agents.js";

describe("BUILTIN_AGENTS.explore.prompt", () => {
	it("exists as a non-empty string", () => {
		// given
		const explore = BUILTIN_AGENTS.explore;
		// when
		const prompt = explore.prompt;
		// then
		expect(prompt).toBeDefined();
		expect(typeof prompt).toBe("string");
		expect((prompt ?? "").length).toBeGreaterThan(0);
	});

	it("does not hardcode specific tool names that can be disabled", () => {
		// given
		const prompt = BUILTIN_AGENTS.explore.prompt ?? "";
		// when
		// then
		expect(prompt).not.toMatch(/\bUse grep\b/);
		expect(prompt).not.toMatch(/\bUse read\b/);
		expect(prompt).not.toMatch(/\bUse bash\b/);
		expect(prompt).not.toMatch(/\bUse find\b/);
		expect(prompt).not.toMatch(/\bUse ls\b/);
	});

	it("does not reference phantom tools that do not exist", () => {
		// given
		const prompt = BUILTIN_AGENTS.explore.prompt ?? "";
		// when
		// then
		expect(prompt).not.toContain("lsp_");
		expect(prompt).not.toContain("ast_grep");
		expect(prompt).not.toContain("glob(");
	});

	it("describes intent and guardrails rather than specific tools", () => {
		// given
		const prompt = BUILTIN_AGENTS.explore.prompt ?? "";
		// when
		// then
		expect(prompt.toLowerCase()).toContain("search");
		expect(prompt).toContain("absolute path");
		expect(prompt.toLowerCase()).toContain("do not create");
	});
});

describe("BUILTIN_AGENTS.general", () => {
	it("has no prompt (uses default system prompt)", () => {
		// given
		const general = BUILTIN_AGENTS.general;
		// when
		const prompt = general.prompt;
		// then
		expect(prompt).toBeUndefined();
	});
});

describe("BUILTIN_AGENTS.explore.permission", () => {
	it("does not grant permission to phantom tools that do not exist", () => {
		// given
		const permission = BUILTIN_AGENTS.explore.permission;
		// when
		const permittedNames = permission.map((rule) => rule.permission);
		// then
		expect(permittedNames).not.toContain("glob");
		expect(permittedNames).not.toContain("lsp_goto_definition");
		expect(permittedNames).not.toContain("lsp_find_references");
		expect(permittedNames).not.toContain("lsp_diagnostics");
		expect(permittedNames).not.toContain("ast_grep");
	});

	it("grants allow to the real built-in tools the explore agent should use", () => {
		// given
		const permission = BUILTIN_AGENTS.explore.permission;
		// when
		const allowedReadOnlyTools = permission.filter((rule) => rule.action === "allow").map((rule) => rule.permission);
		// then
		expect(allowedReadOnlyTools).toContain("read");
		expect(allowedReadOnlyTools).toContain("grep");
		expect(allowedReadOnlyTools).toContain("find");
		expect(allowedReadOnlyTools).toContain("ls");
		expect(allowedReadOnlyTools).toContain("bash");
	});
});
