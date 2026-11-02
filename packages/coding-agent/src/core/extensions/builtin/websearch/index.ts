import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../types.ts";
import { ANTHROPIC_WEB_SEARCH_SECTION } from "../anthropic-web-search/index.ts";
import { OPENAI_WEB_SEARCH_SECTION } from "../openai-web-search/index.ts";
import {
	hasServerSearchFailed,
	rememberServerSearchFailure,
	resetServerSearchFailures,
} from "../server-search-fallback.ts";
import {
	additionalServerSearch,
	hasServerSearch,
	type SearchModel,
	serverSearchFailure,
	serverSearchPayload,
} from "./server-search.ts";

import { loadWebsearchConfig } from "./websearch/config.ts";
import { attemptRouteLabel } from "./websearch/route-attempts.ts";
import { providerEntryLabel } from "./websearch/search.ts";
import { resolveNativeSearchModel } from "./websearch/search-model.ts";
import { createWebSearchTool } from "./websearch/tool.ts";
import type { ConfigLoadResult, WebsearchConfig } from "./websearch/types.ts";

const STATUS_KEY = "pi-websearch";
const WIDGET_KEY = "pi-websearch";
const NATIVE_BYPASS_MESSAGE = "Native provider web search is handled by the built-in provider extension.";

type NativeCapableModel = SearchModel | undefined;

export default function (pi: ExtensionAPI): void {
	let state: ConfigLoadResult = {
		ok: false,
		reason: "missing_config",
		message: "Missing websearch config. Create .pi/websearch.json or ~/.pi/websearch.json before starting pi.",
	};

	function providerList(config: WebsearchConfig): string {
		return config.providers.map(providerEntryLabel).join(", ");
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

	let lastServedBy: string | undefined;
	let nativeFailed = false;
	let fallbackPending = false;
	let fallbackSent = false;
	let userAborted = false;
	let requestModel: ExtensionContext["model"];

	// senpi#2340: status names the model native search runs on, warns about an ignored nativeModel,
	// and reports which route and model served the last search.
	function nativeModelStatus(config: WebsearchConfig, ctx: ExtensionContext): { text: string; warning?: string } {
		const choice = config.auto
			? resolveNativeSearchModel(ctx.model, ctx.modelRegistry, config.nativeModel)
			: undefined;
		const parts: string[] = [];
		if (choice) {
			const fallback = choice.fallbackModel ? ` (falls back to ${choice.fallbackModel})` : "";
			parts.push(`native model=${choice.model}${fallback}`);
		}
		if (lastServedBy) parts.push(`last search via ${lastServedBy}`);
		const text = parts.map((part) => `, ${part}`).join("");
		if (choice?.warning) return { text, warning: choice.warning };
		if (config.nativeModel && !choice) {
			const reason = config.auto ? "the session model has no hosted web search route" : "auto is disabled";
			return { text, warning: `nativeModel "${config.nativeModel}" is ignored: ${reason}.` };
		}
		return { text };
	}

	const searchTool = createWebSearchTool(() => state, {
		onSearchComplete: (details) => {
			if (!details.error) lastServedBy = attemptRouteLabel(details);
		},
	});
	pi.registerTool(searchTool);
	pi.registerTool(
		defineTool({
			name: "$web_search",
			exposure: "search",
			allowLazyActivation: false,
			label: "Moonshot Server Search",
			description: "Return the Moonshot built-in server search result to the same model.",
			parameters: Type.Record(Type.String(), Type.Unknown()),
			async execute(_id, params) {
				// Official Moonshot flow: echo generated arguments, never make a
				// separate request or substitute another model.
				return { content: [{ type: "text", text: JSON.stringify(params) }], details: params };
			},
		}),
	);

	async function refreshState(model: NativeCapableModel, ctx: ExtensionContext): Promise<void> {
		state =
			!nativeFailed && hasServerSearch(model)
				? { ok: false, reason: "provider_native_bypass", message: NATIVE_BYPASS_MESSAGE }
				: await loadWebsearchConfig({ cwd: ctx.cwd });
		const active = pi.getActiveTools();
		const withoutMoonshot = active.filter((name) => name !== "$web_search");
		const moonshotEnabled = !nativeFailed && additionalServerSearch(model) === "moonshot";
		if (moonshotEnabled !== active.includes("$web_search")) {
			pi.setActiveTools(moonshotEnabled ? [...withoutMoonshot, "$web_search"] : withoutMoonshot);
		}
		updateUi(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		lastServedBy = undefined;
		resetServerSearchFailures(ctx.sessionManager);
		nativeFailed = false;
		fallbackPending = false;
		fallbackSent = false;
		userAborted = false;
		await refreshState(ctx.model, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		nativeFailed = hasServerSearchFailed(ctx.sessionManager, event.model);
		fallbackPending = false;
		fallbackSent = false;
		await refreshState(event.model, ctx);
	});

	pi.on(
		"before_agent_start",
		async (event, ctx) => {
			if (!event.preview && event.trigger !== "extension") {
				nativeFailed = hasServerSearchFailed(ctx.sessionManager, ctx.model);
				fallbackPending = false;
				fallbackSent = false;
				userAborted = false;
				await refreshState(ctx.model, ctx);
			}
			if (!hasServerSearch(ctx.model)) return undefined;
			const systemPrompt = event.systemPrompt
				.replace(ANTHROPIC_WEB_SEARCH_SECTION, "")
				.replace(OPENAI_WEB_SEARCH_SECTION, "");
			return {
				systemPrompt: `${systemPrompt}\n## Web Search\n${
					hasServerSearchFailed(ctx.sessionManager, ctx.model)
						? "Use the standalone web_search tool when current information is needed. Native search failed for this session model."
						: "Use the provider's in-turn server web search when current information is needed."
				}`,
			};
		},
		{ previewSafe: true },
	);

	pi.on("before_provider_request", (event, ctx) => {
		requestModel = event.model ?? ctx.model;
		return serverSearchPayload(requestModel, event.payload, hasServerSearchFailed(ctx.sessionManager, requestModel));
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return undefined;
		const message = event.message;
		const model =
			requestModel?.api === message.api &&
			requestModel.provider === message.provider &&
			requestModel.id === message.model
				? requestModel
				: ctx.model?.api === message.api &&
						ctx.model.provider === message.provider &&
						ctx.model.id === message.model
					? ctx.model
					: ctx.modelRegistry.find(message.provider, message.model);
		if (!model || hasServerSearchFailed(ctx.sessionManager, model) || !hasServerSearch(model)) return undefined;
		const reason = serverSearchFailure(message, model);
		if (!reason) return undefined;
		nativeFailed = true;
		rememberServerSearchFailure(ctx.sessionManager, model);
		// A provider can recover from a failed search and still finish its answer.
		// Enable fallback for another request, but never duplicate a completed answer.
		fallbackPending =
			event.message.stopReason === "error" ||
			!event.message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
		await refreshState(model, ctx);
		pi.appendEntry("websearch-native-fallback", { reason });
		if (ctx.hasUI) ctx.ui.notify(`Web search fallback: ${reason}.`, "warning");
		return undefined;
	});

	pi.on("agent_end", (event) => {
		userAborted = event.abortSource === "user";
		// The core retry already continues the original request with the restored function tool.
		if (event.willRetry || userAborted) fallbackPending = false;
	});

	pi.on("session_abort", () => {
		userAborted = true;
		fallbackPending = false;
	});

	pi.on("agent_settled", () => {
		if (!fallbackPending || fallbackSent || userAborted) return;
		fallbackPending = false;
		fallbackSent = true;
		pi.sendMessage(
			{
				customType: "websearch-native-fallback",
				content:
					"Continue the original request using the standalone web_search tool. Do not retry native server search on this turn.",
				display: false,
			},
			{ triggerTurn: true },
		);
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
				const native = nativeModelStatus(state.config, ctx);
				const summary = `Web search active: strategy=${state.config.strategy}, auto=${state.config.auto ? "enabled" : "disabled"}, providers=${providerList(state.config)}${native.text}`;
				ctx.ui.notify(
					native.warning ? `${summary}\nWarning: ${native.warning}` : summary,
					native.warning ? "warning" : "info",
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
