import { resolveToolNameMatch } from "@earendil-works/pi-ai/utils/tool-name-match";
import type { AgentToolResult } from "./types.ts";

/**
 * A model can call a tool by a name it was never registered under: recased,
 * under a gateway namespace (`mcp__<id>__<Name>`, any case), or without the
 * namespace a registered tool carries. The shared matcher resolves such a name
 * only when exactly one available tool matches; it never guesses.
 */
export function resolveToolNameAlias(requested: string, available: Iterable<string>): string | undefined {
	return resolveToolNameMatch(requested, available);
}

export function toolNameCorrectionNotice(requested: string, resolved: string): string {
	return `[auto-corrected] no tool is named "${requested}"; ran "${resolved}". Call tools by their exact listed name.`;
}

export function withToolNameCorrection(
	result: AgentToolResult<unknown>,
	requestedName: string,
	resolvedName: string,
): AgentToolResult<unknown> {
	return {
		...result,
		// Model-only: it steers the model back to exact names; the user sees the resolved tool as if called directly.
		content: [
			{ type: "text", text: toolNameCorrectionNotice(requestedName, resolvedName), audience: "model" },
			...(result.content ?? []),
		],
	};
}
