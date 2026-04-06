import { describe, expect, it } from "vitest";
import {
	type AgentFrontmatter,
	validateAgentConfig,
} from "../../../src/core/extensions/builtin/agent-system/agent-types.js";
import type { Ruleset } from "../../../src/core/extensions/builtin/agent-system/types.js";

describe("validateAgentConfig", () => {
	it("returns AgentInfo for valid config with all fields", () => {
		// given
		const name = "test-agent";
		const frontmatter: AgentFrontmatter = {
			description: "A test agent",
			mode: "subagent",
			model: "claude-sonnet-4",
			temperature: 0.7,
			tools: { read: "allow", bash: "ask" },
			disable: false,
		};
		const body = "You are a helpful test agent.";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error)) {
			expect(result.name).toBe("test-agent");
			expect(result.description).toBe("A test agent");
			expect(result.mode).toBe("subagent");
			expect(result.model).toBe("claude-sonnet-4");
			expect(result.temperature).toBe(0.7);
			expect(result.prompt).toBe("You are a helpful test agent.");
			expect(result.permission).toBeDefined();
			expect(result.native).toBe(false);
		}
	});

	it("returns AgentInfo with defaults for minimal config", () => {
		// given
		const name = "minimal-agent";
		const frontmatter: AgentFrontmatter = {};
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error)) {
			expect(result.name).toBe("minimal-agent");
			expect(result.description).toBeUndefined();
			expect(result.mode).toBe("all");
			expect(result.model).toBeUndefined();
			expect(result.temperature).toBeUndefined();
			expect(result.prompt).toBe("");
			expect(result.permission).toEqual([]);
			expect(result.native).toBe(false);
		}
	});

	it("returns Error for invalid mode", () => {
		// given
		const name = "invalid-mode-agent";
		const frontmatter = { mode: "invalid" } as unknown as AgentFrontmatter;
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).toBeInstanceOf(Error);
		if (result instanceof Error) {
			expect(result.message).toContain("mode");
		}
	});

	it("returns Error for temperature above 2", () => {
		// given
		const name = "invalid-temp-agent";
		const frontmatter = { temperature: 2.5 } as unknown as AgentFrontmatter;
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).toBeInstanceOf(Error);
		if (result instanceof Error) {
			expect(result.message).toContain("temperature");
		}
	});

	it("returns Error for temperature below 0", () => {
		// given
		const name = "invalid-temp-agent";
		const frontmatter = { temperature: -0.5 } as unknown as AgentFrontmatter;
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).toBeInstanceOf(Error);
		if (result instanceof Error) {
			expect(result.message).toContain("temperature");
		}
	});

	it("accepts temperature at boundary 0", () => {
		// given
		const name = "temp-boundary-agent";
		const frontmatter: AgentFrontmatter = { temperature: 0 };
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error)) {
			expect(result.temperature).toBe(0);
		}
	});

	it("accepts temperature at boundary 2", () => {
		// given
		const name = "temp-boundary-agent";
		const frontmatter: AgentFrontmatter = { temperature: 2 };
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error)) {
			expect(result.temperature).toBe(2);
		}
	});

	it("body becomes prompt field", () => {
		// given
		const name = "prompt-test";
		const frontmatter: AgentFrontmatter = {};
		const body = "This is the agent prompt content.";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error)) {
			expect(result.prompt).toBe("This is the agent prompt content.");
		}
	});

	it("converts tools to permission Ruleset via fromConfig", () => {
		// given
		const name = "permission-test";
		const frontmatter: AgentFrontmatter = {
			tools: {
				read: "allow",
				bash: "deny",
				write: "ask",
			},
		};
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error)) {
			expect(result.permission).toEqual([
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "bash", pattern: "*", action: "deny" },
				{ permission: "write", pattern: "*", action: "ask" },
			] as Ruleset);
		}
	});

	it("handles nested tool patterns in fromConfig", () => {
		// given
		const name = "nested-permission-test";
		const frontmatter: AgentFrontmatter = {
			tools: {
				read: "allow",
				bash: { "*.ts": "allow", "*.js": "ask" },
			},
		};
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error)) {
			expect(result.permission).toEqual([
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "bash", pattern: "*.ts", action: "allow" },
				{ permission: "bash", pattern: "*.js", action: "ask" },
			] as Ruleset);
		}
	});

	it("rejects invalid tool action", () => {
		// given
		const name = "invalid-tool-agent";
		const frontmatter = { tools: { read: "invalid" } } as unknown as AgentFrontmatter;
		const body = "";
		// when
		const result = validateAgentConfig(name, frontmatter, body);
		// then
		expect(result).toBeInstanceOf(Error);
		if (result instanceof Error) {
			expect(result.message).toContain("tools");
		}
	});

	it("accepts all valid modes", () => {
		// given
		const modes = ["subagent", "primary", "all"] as const;
		for (const mode of modes) {
			const name = `mode-test-${mode}`;
			const frontmatter: AgentFrontmatter = { mode };
			const body = "";
			// when
			const result = validateAgentConfig(name, frontmatter, body);
			// then
			expect(result).not.toBeInstanceOf(Error);
			if (!(result instanceof Error)) {
				expect(result.mode).toBe(mode);
			}
		}
	});
});
