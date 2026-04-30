import type { ExtensionFactory } from "../types.js";
import agentSystemExtension from "./agent-system/index.js";
import backgroundTaskExtension from "./background-task/index.js";
import bashTimeoutExtension from "./bash-timeout.js";
import compactionExtension from "./compaction/index.js";
import gptApplyPatchExtension from "./gpt-apply-patch.js";
import parallelToolCallsExtension from "./parallel-tool-calls.js";
import permissionSystemExtension from "./permission-system/index.js";
import promptPresetExtension from "./prompt-preset/index.js";
import redrawsExtension from "./redraws.js";
import serviceTierExtension from "./service-tier.js";
import todowriteExtension from "./todotools/index.js";

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
	{ id: "parallel-tool-calls", factory: parallelToolCallsExtension },
	{ id: "service-tier", factory: serviceTierExtension },
	{ id: "bash-timeout", factory: bashTimeoutExtension },
	{ id: "compaction", factory: compactionExtension },
];
