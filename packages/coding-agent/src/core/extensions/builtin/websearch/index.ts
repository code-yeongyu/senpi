import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isAnthropicWebSearchEnabled, supportsNativeAnthropicWebSearch } from "../anthropic-web-search/index.ts";
import { isOpenaiWebSearchEnabled, supportsNativeOpenAiWebSearch } from "../openai-web-search/index.ts";

import { loadWebsearchConfig } from "./websearch/config.ts";
import { createWebSearchTool } from "./websearch/tool.ts";
import type { ConfigLoadResult, WebsearchConfig } from "./websearch/types.ts";

const STATUS_KEY = "pi-websearch";
const WIDGET_KEY = "pi-websearch";
const NATIVE_BYPASS_MESSAGE = "Native provider web search is handled by the built-in provider extension.";

type NativeCapableModel = Parameters<typeof supportsNativeAnthropicWebSearch>[0] &
	Parameters<typeof supportsNativeOpenAiWebSearch>[0];

// Defer to the provider-native server-side web_search only when the builtin
// injecting extension will actually add it for this exact model (first-party
// endpoint or explicit compat opt-in, and not disabled via env). A provider id
// of "anthropic"/"openai" alone is not enough: proxied baseUrls (ccapi, quotio,
// …) never receive the native tool, so bypassing there leaves no web search.
function isProviderNativeBypass(model: NativeCapableModel): boolean {
	if (supportsNativeAnthropicWebSearch(model)) return isAnthropicWebSearchEnabled();
	if (supportsNativeOpenAiWebSearch(model)) return isOpenaiWebSearchEnabled();
	return false;
}

export default function (pi: ExtensionAPI): void {
	let state: ConfigLoadResult = {
		ok: false,
		reason: "missing_config",
		message: "Missing websearch config. Create .pi/websearch.json or ~/.pi/websearch.json before starting pi.",
	};

	function providerLabel(provider: WebsearchConfig["providers"][number]): string {
		return provider.id ? `${provider.id}/${provider.provider}` : provider.provider;
	}

	function providerList(config: WebsearchConfig): string {
		return config.providers.map(providerLabel).join(", ");
	}

	function clearUi(ctx: ExtensionContext): void {
		if (ctx.hasUI === false) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (ctx.hasUI === false) return;
		if (state.ok) {
			clearUi(ctx);
			return;
		}
		if (state.reason === "provider_native_bypass") {
			clearUi(ctx);
			return;
		}
		clearUi(ctx);
		ctx.ui.notify(state.message, "error");
	}

	pi.registerTool(createWebSearchTool(() => state));

	async function refreshState(model: NativeCapableModel, ctx: ExtensionContext): Promise<void> {
		state = isProviderNativeBypass(model)
			? { ok: false, reason: "provider_native_bypass", message: NATIVE_BYPASS_MESSAGE }
			: await loadWebsearchConfig({ cwd: ctx.cwd });
		updateUi(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await refreshState(ctx.model, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		await refreshState(event.model, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearUi(ctx);
	});

	pi.registerCommand("websearch", {
		description: "Show web search provider status",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (args !== "" && args !== "status") {
				ctx.ui.notify("Usage: /websearch status", "warning");
				return;
			}
			if (state.ok) {
				ctx.ui.notify(
					`Web search active: strategy=${state.config.strategy}, auto=${state.config.auto ? "enabled" : "disabled"}, providers=${providerList(state.config)}`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				state.reason === "provider_native_bypass"
					? `Web search deferred: ${state.message}`
					: `Web search inactive: ${state.message}`,
				state.reason === "provider_native_bypass" ? "info" : "error",
			);
		},
	});
}
