import type { ExtensionFactory } from "../types.js";
import parallelToolCallsExtension from "./parallel-tool-calls.js";
import redrawsExtension from "./redraws.js";
import todowriteExtension from "./todowrite.js";

export interface BuiltinExtensionFactory {
	id: string;
	factory: ExtensionFactory;
}

export const globalDefaultExtensionIds = ["diff", "files", "prompt-url-widget", "tps"] as const;

export const builtinExtensions: BuiltinExtensionFactory[] = [
	{ id: "todowrite", factory: todowriteExtension },
	{ id: "redraws", factory: redrawsExtension },
	{ id: "parallel-tool-calls", factory: parallelToolCallsExtension },
];
