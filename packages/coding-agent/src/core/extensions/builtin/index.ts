import type { ExtensionFactory } from "../types.ts";
import accountExtension from "./account/index.ts";
import anthropicBashExtension from "./anthropic-bash/index.ts";
import anthropicWebSearchExtension from "./anthropic-web-search/index.ts";
import bashTimeoutExtension from "./bash-timeout/index.ts";
import btwExtension from "./btw/index.ts";
import cacheKeepAliveExtension from "./cache-keepalive/index.ts";
import claudeSdkOauthExtension from "./claude-sdk-oauth/index.ts";
import compactionExtension from "./compaction/index.ts";
import configReloadExtension from "./config-reload/index.ts";
import cursorCliOauthExtension from "./cursor-cli-oauth/index.ts";
import diffExtension from "./diff.ts";
import filesExtension from "./files.ts";
import goalExtension from "./goal/index.ts";
import gptAccountExtension from "./gpt-account.ts";
import gptApplyPatchExtension from "./gpt-apply-patch/index.ts";
import helpExtension from "./help/index.ts";
import historySearchExtension from "./history-search/index.ts";
import hooksExtension from "./hooks/index.ts";
import imageGenExtension from "./imagegen/index.ts";
import importReproExtension from "./import-repro.ts";
import lookAtExtension from "./look-at/index.ts";
import loopExtension from "./loop/index.ts";
import loopGuardExtension from "./loop-guard/index.ts";
import mcpExtension from "./mcp/index.ts";
import modelFallbackExtension from "./model-fallback/index.ts";
import nestedAgentsMdExtension from "./nested-agents-md/index.ts";
import openaiImageGenExtension from "./openai-image-gen/index.ts";
import openaiWebSearchExtension from "./openai-web-search/index.ts";
import permissionSystemExtension from "./permission-system/index.ts";
import promptPresetExtension from "./prompt-preset/index.ts";
import promptUrlWidgetExtension from "./prompt-url-widget.ts";
import reasoningExtension from "./reasoning/index.ts";
import recommendedModelsExtension from "./recommended-models/index.ts";
import redrawsExtension from "./redraws.ts";
import piRulesExtension from "./rules/index.ts";
import serviceTierExtension from "./service-tier.ts";
import terminalExtension from "./terminal/index.ts";
import todowriteExtension from "./todotools/index.ts";
import toolPairGuardExtension from "./tool-pair-guard/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
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
	// Loop guard owns the first veto opportunity so repeated calls never re-run hooks or permission prompts.
	{ id: "loop-guard", factory: loopGuardExtension },
	{ id: "hooks", factory: hooksExtension },
	{ id: "permission-system", factory: permissionSystemExtension },
	{ id: "gpt-apply-patch", factory: gptApplyPatchExtension },
	{ id: "imagegen", factory: imageGenExtension },
	// Follows imagegen so the native injector's bypass wiring observes the registered client tool.
	{ id: "openai-image-gen", factory: openaiImageGenExtension },
	{ id: "prompt-preset", factory: promptPresetExtension },
	{ id: "todowrite", factory: todowriteExtension },
	{ id: "redraws", factory: redrawsExtension },
	{ id: "anthropic-web-search", factory: anthropicWebSearchExtension },
	{ id: "anthropic-bash", factory: anthropicBashExtension },
	{ id: "openai-web-search", factory: openaiWebSearchExtension },
	{ id: "service-tier", factory: serviceTierExtension },
	// Sits beside service-tier: both are capability-aware model-control commands that only read
	// the active model and notify; neither mutates payloads, so relative order is not load-bearing.
	{ id: "reasoning", factory: reasoningExtension },
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
	{ id: "loop", factory: loopExtension },
	{ id: "cache-keepalive", factory: cacheKeepAliveExtension },
	{ id: "ttsr", factory: ttsrExtension },
	{ id: "btw", factory: btwExtension },
	// Provider-neutral account listing; sits before the provider lanes so their
	// dedicated commands (claude-account, cursor accounts) keep their own names.
	{ id: "account", factory: accountExtension },
	{ id: "gpt-account", factory: gptAccountExtension },
	{ id: "claude-sdk-oauth", factory: claudeSdkOauthExtension },
	// Registers unconditionally and reports executable/auth state through its oauth check, so it stays beside the other provider lane.
	{ id: "cursor-cli-oauth", factory: cursorCliOauthExtension },
	// Config reload follows settings-dependent builtins so reloads rebuild their resolved settings before catalog feeders observe them.
	{ id: "config-reload", factory: configReloadExtension },
	// Shared catalog wiring loads before MCP, which feeds its tools into the shared catalog as the final builtin.
	{ id: "tool-search", factory: toolSearchExtension },
	// Keep MCP last so its eventual provider-payload tap observes all co-resident builtin mutations.
	{ id: "mcp", factory: mcpExtension },
];
