import type { InlineExtension } from "../core/extensions/types.ts";
import htmlRenderExtension from "./html-render/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{
		name: "html-render",
		host: true,
		hidden: true,
		factory: htmlRenderExtension,
	},
];
