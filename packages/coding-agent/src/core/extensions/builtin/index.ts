import type { ExtensionFactory } from "../types.ts";
import anthropicBashExtension from "./anthropic-bash/index.ts";
import anthropicWebSearchExtension from "./anthropic-web-search/index.ts";
import bashTimeoutExtension from "./bash-timeout/index.ts";
import btwExtension from "./btw/index.ts";
import cacheKeepAliveExtension from "./cache-keepalive/index.ts";
import claudeSdkOauthExtension from "./claude-sdk-oauth/index.ts";
import compactionExtension from "./compaction/index.ts";
import configReloadExtension from "./config-reload/index.ts";
import diffExtension from "./diff.ts";
import filesExtension from "./files.ts";
import goalExtension from "./goal/index.ts";
import gptApplyPatchExtension from "./gpt-apply-patch/index.ts";
import helpExtension from "./help/index.ts";
import historySearchExtension from "./history-search/index.ts";
import hooksExtension from "./hooks/index.ts";
import importReproExtension from "./import-repro.ts";
import lookAtExtension from "./look-at/index.ts";
import loopGuardExtension from "./loop-guard/index.ts";
import mcpExtension from "./mcp/index.ts";
import modelFallbackExtension from "./model-fallback/index.ts";
import nestedAgentsMdExtension from "./nested-agents-md/index.ts";
import openaiWebSearchExtension from "./openai-web-search/index.ts";
import permissionSystemExtension from "./permission-system/index.ts";
import promptPresetExtension from "./prompt-preset/index.ts";
import promptUrlWidgetExtension from "./prompt-url-widget.ts";
import recommendedModelsExtension from "./recommended-models/index.ts";
import redrawsExtension from "./redraws.ts";
import piRulesExtension from "./rules/index.ts";
import serviceTierExtension from "./service-tier.ts";
import terminalExtension from "./terminal/index.ts";
import todowriteExtension from "./todotools/index.ts";
import toolPairGuardExtension from "./tool-pair-guard/index.ts";
import tpsExtension from "./tps.ts";
import ttsrExtension from "./ttsr/index.ts";
import videoInExtension from "./video-in/index.ts";
import webfetchExtension from "./webfetch/index.ts";
import websearchExtension from "./websearch/index.ts";

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
	{ id: "hooks", factory: hooksExtension },
	{ id: "permission-system", factory: permissionSystemExtension },
	{ id: "gpt-apply-patch", factory: gptApplyPatchExtension },
	{ id: "prompt-preset", factory: promptPresetExtension },
	{ id: "todowrite", factory: todowriteExtension },
	{ id: "redraws", factory: redrawsExtension },
	{ id: "anthropic-web-search", factory: anthropicWebSearchExtension },
	{ id: "anthropic-bash", factory: anthropicBashExtension },
	{ id: "openai-web-search", factory: openaiWebSearchExtension },
	{ id: "service-tier", factory: serviceTierExtension },
	{ id: "model-fallback", factory: modelFallbackExtension },
	{ id: "recommended-models", factory: recommendedModelsExtension },
	{ id: "bash-timeout", factory: bashTimeoutExtension },
	// Terminal follows bash-timeout so its injected default reaches the PTY bash, and follows
	// anthropic-bash so mutual-exclusion (companion step-aside) is evaluated after it registers.
	{ id: "terminal", factory: terminalExtension },
	{ id: "tool-pair-guard", factory: toolPairGuardExtension },
	{ id: "compaction", factory: compactionExtension },
	{ id: "history-search", factory: historySearchExtension },
	{ id: "help", factory: helpExtension },
	{ id: "import-repro", factory: importReproExtension },
	{ id: "websearch", factory: websearchExtension },
	{ id: "webfetch", factory: webfetchExtension },
	{ id: "video-in", factory: videoInExtension },
	{ id: "look-at", factory: lookAtExtension },
	{ id: "nested-agents-md", factory: nestedAgentsMdExtension },
	{ id: "rules", factory: piRulesExtension },
	{ id: "goal", factory: goalExtension },
	{ id: "cache-keepalive", factory: cacheKeepAliveExtension },
	{ id: "ttsr", factory: ttsrExtension },
	{ id: "btw", factory: btwExtension },
	{ id: "claude-sdk-oauth", factory: claudeSdkOauthExtension },
	// Loop guard is a pure observer of tool_execution_start; it never mutates payloads, so it slots before config-reload and leaves MCP last.
	{ id: "loop-guard", factory: loopGuardExtension },
	// Config reload follows settings-dependent builtins so reloads rebuild their resolved settings before MCP observes them.
	{ id: "config-reload", factory: configReloadExtension },
	// Keep MCP last so its eventual provider-payload tap observes all co-resident builtin mutations.
	{ id: "mcp", factory: mcpExtension },
];
