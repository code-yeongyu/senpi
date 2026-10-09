import type { AssistantMessage, ProviderId } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "./diagnostics.ts";

export const GITHUB_COPILOT_TOOL_LIMIT = 128;
export const GITHUB_COPILOT_TOOL_LIMIT_DIAGNOSTIC = "github_copilot_tool_limit";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function selectedToolName(toolChoice: unknown): string | undefined {
	if (!isRecord(toolChoice)) return undefined;
	if (toolChoice.type === "function") {
		if (isRecord(toolChoice.function) && typeof toolChoice.function.name === "string") {
			return toolChoice.function.name;
		}
		return typeof toolChoice.name === "string" ? toolChoice.name : undefined;
	}
	if (toolChoice.type !== "custom" && toolChoice.type !== "tool") return undefined;
	return typeof toolChoice.name === "string" ? toolChoice.name : undefined;
}

function toolName(tool: unknown): string | undefined {
	if (!isRecord(tool)) return undefined;
	if (tool.type === "function") {
		if (isRecord(tool.function) && typeof tool.function.name === "string") return tool.function.name;
		return typeof tool.name === "string" ? tool.name : undefined;
	}
	return typeof tool.name === "string" ? tool.name : undefined;
}

export function limitGitHubCopilotTools<T>(
	provider: ProviderId,
	tools: T[] | undefined,
	toolChoice?: unknown,
): { tools: T[] | undefined; omittedCount: number } {
	if (provider !== "github-copilot" || tools === undefined || tools.length <= GITHUB_COPILOT_TOOL_LIMIT) {
		return { tools, omittedCount: 0 };
	}
	const forcedName = selectedToolName(toolChoice);
	const forcedIndex = forcedName === undefined ? -1 : tools.findIndex((tool) => toolName(tool) === forcedName);
	if (forcedIndex >= GITHUB_COPILOT_TOOL_LIMIT) {
		const forcedTool = tools[forcedIndex];
		if (forcedTool !== undefined) {
			return {
				tools: [...tools.slice(0, GITHUB_COPILOT_TOOL_LIMIT - 1), forcedTool],
				omittedCount: tools.length - GITHUB_COPILOT_TOOL_LIMIT,
			};
		}
	}
	return {
		tools: tools.slice(0, GITHUB_COPILOT_TOOL_LIMIT),
		omittedCount: tools.length - GITHUB_COPILOT_TOOL_LIMIT,
	};
}

export function recordGitHubCopilotToolLimit(message: AssistantMessage, omittedCount: number): void {
	if (
		omittedCount === 0 ||
		message.diagnostics?.some((diagnostic) => diagnostic.type === GITHUB_COPILOT_TOOL_LIMIT_DIAGNOSTIC)
	) {
		return;
	}
	appendAssistantMessageDiagnostic(message, {
		type: GITHUB_COPILOT_TOOL_LIMIT_DIAGNOSTIC,
		timestamp: Date.now(),
		details: {
			limit: GITHUB_COPILOT_TOOL_LIMIT,
			omittedCount,
			message: `GitHub Copilot accepts at most ${GITHUB_COPILOT_TOOL_LIMIT} tools on endpoints without tool search; senpi omitted ${omittedCount} excess tool definition${omittedCount === 1 ? "" : "s"}.`,
		},
	});
}

export function formatGitHubCopilotToolLimitError(message: AssistantMessage, errorMessage: string): string {
	const toolLimitApplied = message.diagnostics?.some(
		(diagnostic) => diagnostic.type === GITHUB_COPILOT_TOOL_LIMIT_DIAGNOSTIC,
	);
	if (
		message.provider !== "github-copilot" ||
		!toolLimitApplied ||
		message.providerDiagnostic?.httpStatus !== 400 ||
		!/400 Bad Request$/i.test(errorMessage)
	) {
		return errorMessage;
	}
	return `GitHub Copilot rejected the request after senpi limited its tool list to ${GITHUB_COPILOT_TOOL_LIMIT}. The endpoint may enforce a lower limit or count additional hosted tools. (${errorMessage})`;
}
