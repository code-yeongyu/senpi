import type { AgentInfo, AgentMode } from "./agent-types.js";
import { BUILTIN_AGENTS } from "./builtin-agents.js";
import { loadAllAgents } from "./loader.js";
import { fromConfig, merge } from "./permission.js";

export class AgentRegistry {
	private agents: Map<string, AgentInfo>;

	constructor(agents: Map<string, AgentInfo>) {
		this.agents = agents;
	}

	get(name: string): AgentInfo | undefined {
		return this.agents.get(name);
	}

	list(): AgentInfo[] {
		return Array.from(this.agents.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	getAvailableAgentDescriptions(): string {
		const lines = ["Available agent types:"];
		for (const agent of this.list()) {
			lines.push(`- ${agent.name}: ${agent.description ?? "No description"}`);
		}
		return lines.join("\n");
	}
}

// v1 limitation: AgentFrontmatter.disable is stripped by validateAgentConfig before reaching here.
// Disabling built-in agents via custom config requires adding `disable` to AgentInfo.
export async function createRegistry(cwd: string): Promise<AgentRegistry> {
	const agents = new Map<string, AgentInfo>();
	for (const [key, agent] of Object.entries(BUILTIN_AGENTS)) {
		agents.set(key, structuredClone(agent));
	}

	const customAgents = await loadAllAgents(cwd);
	for (const [key, custom] of Object.entries(customAgents)) {
		const existing = agents.get(key) ?? {
			name: key,
			mode: "all" as AgentMode,
			permission: merge(fromConfig({})),
			native: false,
		};
		agents.set(key, {
			...existing,
			...(custom.model !== undefined && { model: custom.model }),
			...(custom.prompt !== undefined && { prompt: custom.prompt }),
			...(custom.description !== undefined && { description: custom.description }),
			...(custom.temperature !== undefined && { temperature: custom.temperature }),
			...(custom.mode !== undefined && { mode: custom.mode }),
			permission: merge(existing.permission, custom.permission),
		});
	}

	return new AgentRegistry(agents);
}
