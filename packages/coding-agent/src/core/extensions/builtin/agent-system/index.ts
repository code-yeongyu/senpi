import { SettingsManager } from "../../../settings-manager.js";
import type { ExtensionAPI } from "../../types.js";
import { AGENT_TYPE_ENV_VAR } from "../background-task/types.js";
import type { AgentInfo } from "./agent-types.js";
import { evaluate, fromConfig, merge } from "./permission.js";
import { createRegistry } from "./registry.js";

export default function agentSystemExtension(pi: ExtensionAPI): void {
	const agentType = process.env[AGENT_TYPE_ENV_VAR];
	if (!agentType) return; // No agent type = legacy mode, no filtering
	let agentInfo: AgentInfo | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const registry = await createRegistry(ctx.cwd);
		const resolved = registry.get(agentType);
		if (!resolved) {
			// Unknown agent type — log warning, continue without restrictions
			process.stderr.write(
				`[agent-system] Unknown agent type: "${agentType}". Available: ${registry.getAvailableAgentDescriptions()}\n`,
			);
			return;
		}
		const settingsManager = SettingsManager.create(ctx.cwd);
		const globalSettings = settingsManager.getGlobalSettings();
		const projectSettings = settingsManager.getProjectSettings();
		const mergedAgentDefaults = { ...globalSettings.agentDefaults, ...projectSettings.agentDefaults };
		const globalDefaults = fromConfig(mergedAgentDefaults.permission ?? {});
		const mergedInfo: AgentInfo = {
			...resolved,
			permission: merge(globalDefaults, resolved.permission),
		};
		agentInfo = mergedInfo;
		const allTools = pi.getAllTools();
		const allowedTools = allTools
			.filter((tool) => evaluate(tool.name, "*", mergedInfo.permission).action !== "deny")
			.map((tool) => tool.name);
		pi.setActiveTools(allowedTools);

		const sessionAllowed = new Set<string>();

		pi.on("before_agent_start", async (event, _ctx) => {
			if (!agentInfo?.prompt) return undefined;
			return {
				systemPrompt: `${event.systemPrompt}\n\n${agentInfo.prompt}`,
			};
		});

		pi.on("tool_call", async (event, toolContext) => {
			if (!agentInfo) return undefined;

			const toolName = event.toolName;

			if (sessionAllowed.has(toolName)) {
				return undefined;
			}

			const rule = evaluate(toolName, "*", agentInfo.permission);

			if (rule.action === "allow") {
				return undefined;
			}

			if (rule.action === "deny") {
				return {
					block: true,
					reason: `Agent "${agentType}" does not have permission to use "${toolName}". This tool is denied by the agent's permission policy.`,
				};
			}

			if (!toolContext.hasUI) {
				return {
					block: true,
					reason: `Agent "${agentType}" requires confirmation to use "${toolName}", but no UI is available. Auto-denied in non-interactive mode.`,
				};
			}

			const selection = await toolContext.ui.select("Agent permission required", [
				"Allow once",
				"Allow always",
				"Deny",
			]);

			if (selection === "Allow once") {
				return undefined;
			}

			if (selection === "Allow always") {
				sessionAllowed.add(toolName);
				return undefined;
			}

			return {
				block: true,
				reason: `Agent "${agentType}" requires confirmation to use "${toolName}". Please configure explicit allow/deny in agent permissions.`,
			};
		});
	});
}
