import type { ExtensionFactory } from "../types.ts";
import anthropicBashExtension from "./anthropic-bash/index.ts";
import anthropicWebSearchExtension from "./anthropic-web-search/index.ts";
import bashTimeoutExtension from "./bash-timeout/index.ts";
import compactionExtension from "./compaction/index.ts";
import diffExtension from "./diff.ts";
import filesExtension from "./files.ts";
import gptApplyPatchExtension from "./gpt-apply-patch/index.ts";
import historySearchExtension from "./history-search/index.ts";
import kimiWebSearchExtension from "./kimi-web-search/index.ts";
import openaiWebSearchExtension from "./openai-web-search/index.ts";
import permissionSystemExtension from "./permission-system/index.ts";
import promptPresetExtension from "./prompt-preset/index.ts";
import promptUrlWidgetExtension from "./prompt-url-widget.ts";
import redrawsExtension from "./redraws.ts";
import serviceTierExtension from "./service-tier.ts";
import todowriteExtension from "./todotools/index.ts";
import toolPairGuardExtension from "./tool-pair-guard/index.ts";
import tpsExtension from "./tps.ts";

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
	{ id: "history-search", factory: historySearchExtension },
	{ id: "kimi-web-search", factory: kimiWebSearchExtension },
];
