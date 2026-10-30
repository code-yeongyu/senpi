import type { InlineExtension } from "../core/extensions/types.ts";
import { attachHostTools } from "../host-tools.ts";
import { showHtmlPageTool } from "./html-render/tool.ts";

export const builtInExtensions: InlineExtension[] = [
	{
		name: "html-render",
		host: true,
		hidden: true,
		factory: (api) => attachHostTools(api, [showHtmlPageTool]),
	},
];
