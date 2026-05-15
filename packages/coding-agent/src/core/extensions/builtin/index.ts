import type { ExtensionFactory } from "../types.js";
import anthropicBashExtension from "./anthropic-bash/index.js";
import anthropicWebSearchExtension from "./anthropic-web-search/index.js";
import bashTimeoutExtension from "./bash-timeout/index.js";
import compactionExtension from "./compaction/index.js";
import diffExtension from "./diff.js";
import filesExtension from "./files.js";
import gptApplyPatchExtension from "./gpt-apply-patch/index.js";
import kimiWebSearchExtension from "./kimi-web-search/index.js";
import openaiWebSearchExtension from "./openai-web-search/index.js";
import permissionSystemExtension from "./permission-system/index.js";
import promptPresetExtension from "./prompt-preset/index.js";
import promptUrlWidgetExtension from "./prompt-url-widget.js";
import redrawsExtension from "./redraws.js";
import serviceTierExtension from "./service-tier.js";
import todowriteExtension from "./todotools/index.js";
import toolPairGuardExtension from "./tool-pair-guard/index.js";
import tpsExtension from "./tps.js";

export interface BuiltinExtensionFactory {
	id: string;
	factory: ExtensionFactory;
}

export const globalDefaultExtensionIds = ["diff", "files", "prompt-url-widget", "tps"] as const;

export const globalDefaultExtensionFactories = {
	diff: diffExtension,
	files: filesExtension,
	"prompt-url-widget": promptUrlWidgetExtension,
	tps: tpsExtension,
} satisfies Record<(typeof globalDefaultExtensionIds)[number], ExtensionFactory>;

export const builtinExtensions: BuiltinExtensionFactory[] = [
	{ id: "permission-system", factory: permissionSystemExtension },
	{ id: "gpt-apply-patch", factory: gptApplyPatchExtension },
	{ id: "prompt-preset", factory: promptPresetExtension },
	{ id: "todowrite", factory: todowriteExtension },
	{ id: "redraws", factory: redrawsExtension },
	{ id: "anthropic-web-search", factory: anthropicWebSearchExtension },
	{ id: "anthropic-bash", factory: anthropicBashExtension },
	{ id: "openai-web-search", factory: openaiWebSearchExtension },
	{ id: "service-tier", factory: serviceTierExtension },
	{ id: "bash-timeout", factory: bashTimeoutExtension },
	{ id: "tool-pair-guard", factory: toolPairGuardExtension },
	{ id: "compaction", factory: compactionExtension },
	{ id: "kimi-web-search", factory: kimiWebSearchExtension },
];
