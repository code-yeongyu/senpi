import type { ExtensionAPI } from "../../types.ts";
import { forgetHandedPages } from "./handed-pages.ts";
import { showHtmlPageTool } from "./tool.ts";

export default function htmlRenderExtension(pi: ExtensionAPI): void {
	pi.registerTool(showHtmlPageTool);
	pi.on("session_shutdown", (_event, ctx) => forgetHandedPages(ctx.sessionManager.getSessionId()));
}
