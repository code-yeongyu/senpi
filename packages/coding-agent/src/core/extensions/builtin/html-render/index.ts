import type { ExtensionAPI } from "../../types.ts";
import { showHtmlPageTool } from "./tool.ts";

export default function htmlRenderExtension(pi: ExtensionAPI): void {
	pi.registerTool(showHtmlPageTool);
}
