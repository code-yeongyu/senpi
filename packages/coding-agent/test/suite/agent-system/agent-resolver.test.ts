import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../../src/core/extensions/builtin/agent-system/agent-types.js";
import { BUILTIN_AGENTS } from "../../../src/core/extensions/builtin/agent-system/builtin-agents.js";
import { fromConfig } from "../../../src/core/extensions/builtin/agent-system/permission.js";

vi.mock("../../../src/core/extensions/builtin/agent-system/loader.js", () => ({
	loadAllAgents: vi.fn(),
}));

import { loadAllAgents } from "../../../src/core/extensions/builtin/agent-system/loader.js";
import { AgentRegistry, createRegistry } from "../../../src/core/extensions/builtin/agent-system/registry.js";

const mockedLoadAllAgents = vi.mocked(loadAllAgents);

describe("AgentRegistry", () => {
	it("returns built-in general agent by name", () => {
		// given
		const generalAgent: AgentInfo = {
			name: "general",
			description: "General-purpose agent",
			mode: "subagent",
			native: true,
			permission: fromConfig({ "*": "allow" }),
		};
		const registry = new AgentRegistry(new Map([["general", generalAgent]]));

		// when
		const result = registry.get("general");

		// then
		expect(result).toBe(generalAgent);
	});

	it("returns built-in explore agent by name", () => {
		// given
		const exploreAgent: AgentInfo = {
			name: "explore",
			description: "Fast codebase exploration",
			mode: "subagent",
			native: true,
			permission: fromConfig({ read: "allow" }),
		};
		const registry = new AgentRegistry(new Map([["explore", exploreAgent]]));

		// when
		const result = registry.get("explore");

		// then
		expect(result).toBe(exploreAgent);
	});

	it("returns undefined for unknown agent name", () => {
		// given
		const registry = new AgentRegistry(new Map());

		// when
		const result = registry.get("unknown");

		// then
		expect(result).toBeUndefined();
	});

	it("returns agents sorted alphabetically by name", () => {
		// given
		const agents = new Map<string, AgentInfo>([
			["zebra", { name: "zebra", mode: "all", native: false, permission: [] }],
			["alpha", { name: "alpha", mode: "all", native: false, permission: [] }],
			["middle", { name: "middle", mode: "all", native: false, permission: [] }],
		]);
		const registry = new AgentRegistry(agents);

		// when
		const result = registry.list();

		// then
		expect(result.map((a) => a.name)).toEqual(["alpha", "middle", "zebra"]);
	});

	it("returns formatted descriptions of all agents", () => {
		// given
		const agents = new Map<string, AgentInfo>([
			["general", { name: "general", description: "General agent", mode: "all", native: true, permission: [] }],
			["explore", { name: "explore", description: "Explorer agent", mode: "all", native: true, permission: [] }],
		]);
		const registry = new AgentRegistry(agents);

		// when
		const result = registry.getAvailableAgentDescriptions();

		// then
		expect(result).toBe("Available agent types:\n- explore: Explorer agent\n- general: General agent");
	});

	it("shows 'No description' for agents without description field", () => {
		// given
		const registry = new AgentRegistry(
			new Map([["bare", { name: "bare", mode: "all", native: false, permission: [] }]]),
		);

		// when
		const result = registry.getAvailableAgentDescriptions();

		// then
		expect(result).toBe("Available agent types:\n- bare: No description");
	});
});

describe("createRegistry", () => {
	beforeEach(() => {
		mockedLoadAllAgents.mockReset();
	});

	it("includes all built-in agents when no custom agents exist", async () => {
		// given
		mockedLoadAllAgents.mockResolvedValue({});

		// when
		const registry = await createRegistry("/fake/cwd");

		// then
		expect(registry.get("general")).toBeDefined();
		expect(registry.get("general")!.name).toBe("general");
		expect(registry.get("explore")).toBeDefined();
		expect(registry.get("explore")!.name).toBe("explore");
	});

	it("overrides built-in fields with custom agent fields", async () => {
		// given
		const customAgent: AgentInfo = {
			name: "general",
			description: "Custom general agent",
			model: "gpt-4o",
			mode: "all",
			native: false,
			permission: [],
		};
		mockedLoadAllAgents.mockResolvedValue({ general: customAgent });

		// when
		const registry = await createRegistry("/fake/cwd");

		// then
		const agent = registry.get("general");
		expect(agent).toBeDefined();
		expect(agent!.description).toBe("Custom general agent");
		expect(agent!.model).toBe("gpt-4o");
		expect(agent!.mode).toBe("all");
		expect(agent!.native).toBe(true);
	});

	it("merges custom agent permissions with built-in permissions", async () => {
		// given
		const customPermission = fromConfig({ bash: "deny" });
		const customAgent: AgentInfo = {
			name: "general",
			mode: "subagent",
			native: false,
			permission: customPermission,
		};
		mockedLoadAllAgents.mockResolvedValue({ general: customAgent });

		// when
		const registry = await createRegistry("/fake/cwd");

		// then
		const agent = registry.get("general");
		expect(agent).toBeDefined();
		const builtinPermissionLength = BUILTIN_AGENTS.general!.permission.length;
		expect(agent!.permission.length).toBe(builtinPermissionLength + customPermission.length);
		const lastRule = agent!.permission[agent!.permission.length - 1];
		expect(lastRule).toEqual({ permission: "bash", pattern: "*", action: "deny" });
	});

	it("adds new custom agents not present in builtins", async () => {
		// given
		const customAgent: AgentInfo = {
			name: "reviewer",
			description: "Code reviewer",
			mode: "subagent",
			native: false,
			permission: fromConfig({ read: "allow" }),
		};
		mockedLoadAllAgents.mockResolvedValue({ reviewer: customAgent });

		// when
		const registry = await createRegistry("/fake/cwd");

		// then
		const agent = registry.get("reviewer");
		expect(agent).toBeDefined();
		expect(agent!.name).toBe("reviewer");
		expect(agent!.description).toBe("Code reviewer");
		expect(agent!.mode).toBe("subagent");
	});

	it("does not mutate the original BUILTIN_AGENTS", async () => {
		// given
		const originalDescription = BUILTIN_AGENTS.general!.description;
		const customAgent: AgentInfo = {
			name: "general",
			description: "Modified",
			model: "custom-model",
			mode: "all",
			native: false,
			permission: [],
		};
		mockedLoadAllAgents.mockResolvedValue({ general: customAgent });

		// when
		await createRegistry("/fake/cwd");

		// then
		expect(BUILTIN_AGENTS.general!.description).toBe(originalDescription);
		expect(BUILTIN_AGENTS.general!.model).toBeUndefined();
	});
});
