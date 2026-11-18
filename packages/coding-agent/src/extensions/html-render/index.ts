import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { attachHostTools } from "../../host-tools.ts";
import { createShowHtmlPageTool, handRoutedHtmlPage, type PendingHandedPages } from "./tool.ts";

export default function htmlRenderExtension(pi: ExtensionAPI): void {
	const pending: PendingHandedPages = new Map();
	attachHostTools(pi, [
		{
			tool: createShowHtmlPageTool(pending),
			// A routed page rides this session's transcript too, so it is held to the same budget.
			settleRouted: (result, toolCallId, params, _signal, _onUpdate, ctx) =>
				handRoutedHtmlPage(toolCallId, params, ctx, pending, result),
		},
	]);
	// Once a run ends every handed page is recorded in the session's entries or never will be, so the
	// ledger of not-yet-recorded pages is empty from then on; shutdown releases it with the session.
	const forget = () => pending.clear();
	pi.on("agent_end", forget);
	pi.on("session_shutdown", forget);
}
