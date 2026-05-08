import type { ExtensionFactory } from "../types.js";
import agentSystemExtension from "./agent-system/index.js";
import anthropicBashExtension from "./anthropic-bash/index.js";
import anthropicCodeExecutionExtension from "./anthropic-code-execution/index.js";
import anthropicComputerUseExtension from "./anthropic-computer-use/index.js";
import anthropicTextEditorExtension from "./anthropic-text-editor/index.js";
import anthropicToolSearchExtension from "./anthropic-tool-search/index.js";
import anthropicWebSearchExtension from "./anthropic-web-search/index.js";
import backgroundTaskExtension from "./background-task/index.js";
import bashTimeoutExtension from "./bash-timeout/index.js";
import compactionExtension from "./compaction/index.js";
import diffExtension from "./diff.js";
import filesExtension from "./files.js";
import googleCodeExecutionExtension from "./google-code-execution/index.js";
import googleGoogleSearchExtension from "./google-google-search/index.js";
import googleUrlContextExtension from "./google-url-context/index.js";
import gptApplyPatchExtension from "./gpt-apply-patch/index.js";
import openaiApiParallelToolCallsExtension from "./openai-api-parallel-tool-calls/index.js";
import openaiCodeInterpreterExtension from "./openai-code-interpreter/index.js";
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
	{ id: "background-task", factory: backgroundTaskExtension },
	{ id: "agent-system", factory: agentSystemExtension },
	{ id: "permission-system", factory: permissionSystemExtension },
	{ id: "gpt-apply-patch", factory: gptApplyPatchExtension },
	{ id: "prompt-preset", factory: promptPresetExtension },
	{ id: "todowrite", factory: todowriteExtension },
	{ id: "redraws", factory: redrawsExtension },
	{ id: "anthropic-web-search", factory: anthropicWebSearchExtension },
	{ id: "anthropic-tool-search", factory: anthropicToolSearchExtension },
	{ id: "anthropic-code-execution", factory: anthropicCodeExecutionExtension },
	{ id: "anthropic-bash", factory: anthropicBashExtension },
	{ id: "anthropic-text-editor", factory: anthropicTextEditorExtension },
	{ id: "anthropic-computer-use", factory: anthropicComputerUseExtension },
	{ id: "openai-web-search", factory: openaiWebSearchExtension },
	{ id: "openai-code-interpreter", factory: openaiCodeInterpreterExtension },
	{ id: "google-google-search", factory: googleGoogleSearchExtension },
	{ id: "google-code-execution", factory: googleCodeExecutionExtension },
	{ id: "google-url-context", factory: googleUrlContextExtension },
	{ id: "openai-api-parallel-tool-calls", factory: openaiApiParallelToolCallsExtension },
	{ id: "service-tier", factory: serviceTierExtension },
	{ id: "bash-timeout", factory: bashTimeoutExtension },
	{ id: "tool-pair-guard", factory: toolPairGuardExtension },
	{ id: "compaction", factory: compactionExtension },
];
