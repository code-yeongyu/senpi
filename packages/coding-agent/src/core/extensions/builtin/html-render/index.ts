import type { ExtensionAPI } from "../../types.ts";
import type { PendingHandedPages } from "./handed-pages.ts";
import { createShowHtmlPageTool } from "./tool.ts";

export default function htmlRenderExtension(pi: ExtensionAPI): void {
	const pending: PendingHandedPages = new Map();
	pi.registerTool(createShowHtmlPageTool(pending));
	// Once a run ends every handed page is recorded in the session's entries or never will be, so the
	// ledger of not-yet-recorded pages is empty from then on; shutdown releases it with the session.
	const forget = () => pending.clear();
	pi.on("agent_end", forget);
	pi.on("session_shutdown", forget);
}
