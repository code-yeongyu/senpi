import type { ExtensionFactory } from "../types.js";
import agentSystemExtension from "./agent-system/index.js";
import backgroundTaskExtension from "./background-task/index.js";
import geminiPromptsExtension from "./gemini-prompts/index.js";
import geminiXmlToolCallLayerExtension from "./gemini-xml-tool-call-layer/index.js";
import parallelToolCallsExtension from "./parallel-tool-calls.js";
import permissionSystemExtension from "./permission-system/index.js";
import redrawsExtension from "./redraws.js";
import todowriteExtension from "./todotools/index.js";

export interface BuiltinExtensionFactory {
	id: string;
	factory: ExtensionFactory;
}

export const globalDefaultExtensionIds = ["diff", "files", "prompt-url-widget", "tps"] as const;

export const builtinExtensions: BuiltinExtensionFactory[] = [
	{ id: "background-task", factory: backgroundTaskExtension },
	{ id: "agent-system", factory: agentSystemExtension },
	{ id: "gemini-prompts", factory: geminiPromptsExtension },
	{ id: "gemini-xml-tool-call-layer", factory: geminiXmlToolCallLayerExtension },
	{ id: "permission-system", factory: permissionSystemExtension },
	{ id: "todowrite", factory: todowriteExtension },
	{ id: "redraws", factory: redrawsExtension },
	{ id: "parallel-tool-calls", factory: parallelToolCallsExtension },
];
