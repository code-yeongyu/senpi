import type { ExtensionFactory } from "../types.js";
import agentSystemExtension from "./agent-system/index.js";
import anthropicToolSearchExtension from "./anthropic-tool-search/index.js";
import anthropicWebFetchExtension from "./anthropic-web-fetch/index.js";
import anthropicWebSearchExtension from "./anthropic-web-search/index.js";
import backgroundTaskExtension from "./background-task/index.js";
import bashTimeoutExtension from "./bash-timeout/index.js";
import compactionExtension from "./compaction/index.js";
import gptApplyPatchExtension from "./gpt-apply-patch/index.js";
import openaiApiParallelToolCallsExtension from "./openai-api-parallel-tool-calls/index.js";
import permissionSystemExtension from "./permission-system/index.js";
import promptPresetExtension from "./prompt-preset/index.js";
import redrawsExtension from "./redraws.js";
import serviceTierExtension from "./service-tier.js";
import todowriteExtension from "./todotools/index.js";
import toolPairGuardExtension from "./tool-pair-guard/index.js";
import webfetchExtension from "./webfetch/index.js";

export interface BuiltinExtensionFactory {
	id: string;
	factory: ExtensionFactory;
}

export const globalDefaultExtensionIds = ["diff", "files", "prompt-url-widget", "tps"] as const;

export const builtinExtensions: BuiltinExtensionFactory[] = [
	{ id: "background-task", factory: backgroundTaskExtension },
	{ id: "agent-system", factory: agentSystemExtension },
	{ id: "permission-system", factory: permissionSystemExtension },
	{ id: "gpt-apply-patch", factory: gptApplyPatchExtension },
	{ id: "prompt-preset", factory: promptPresetExtension },
	{ id: "todowrite", factory: todowriteExtension },
	{ id: "redraws", factory: redrawsExtension },
	{ id: "anthropic-web-search", factory: anthropicWebSearchExtension },
	{ id: "anthropic-web-fetch", factory: anthropicWebFetchExtension },
	{ id: "anthropic-tool-search", factory: anthropicToolSearchExtension },
	{ id: "openai-api-parallel-tool-calls", factory: openaiApiParallelToolCallsExtension },
	{ id: "service-tier", factory: serviceTierExtension },
	{ id: "bash-timeout", factory: bashTimeoutExtension },
	{ id: "webfetch", factory: webfetchExtension },
	{ id: "tool-pair-guard", factory: toolPairGuardExtension },
	{ id: "compaction", factory: compactionExtension },
];
