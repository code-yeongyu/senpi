import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { extractChatGptSubscriptionAccountId } from "@earendil-works/pi-ai";

import {
	type CodexUsagePollingController,
	codexUsageStatusText,
	fetchCodexUsage,
	startCodexUsagePolling,
} from "./codex-usage.ts";

const STATUS_KEY = "provider-usage";
const UNAVAILABLE_STATUS = "Codex usage unavailable";

export function shouldLoadCodexUsage(provider: string | undefined, usingOAuth: boolean, hasUi: boolean): boolean {
	return hasUi && provider === "chatgpt-subscription" && usingOAuth;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let polling: CodexUsagePollingController | undefined;

	const stop = (): void => {
		polling?.stop();
		polling = undefined;
	};

	const load = async (ctx: ExtensionContext, signal: AbortSignal) => {
		const model = ctx.model;
		if (!model || !shouldLoadCodexUsage(model.provider, ctx.modelRegistry.isUsingOAuth(model), ctx.hasUI)) {
			return null;
		}
		const auth = await abortable(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
		if (!auth.ok || !auth.apiKey) return null;
		const accountId = extractChatGptSubscriptionAccountId(auth.apiKey);
		if (!accountId) return null;
		return fetchCodexUsage({
			credentials: {
				accessToken: auth.apiKey,
				accountId,
			},
			signal,
		});
	};

	const restart = (ctx: ExtensionContext): void => {
		stop();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (
			!enabled ||
			!ctx.model ||
			!shouldLoadCodexUsage(ctx.model.provider, ctx.modelRegistry.isUsingOAuth(ctx.model), ctx.hasUI)
		) {
			return;
		}
		polling = startCodexUsagePolling({
			active: () =>
				enabled &&
				Boolean(
					ctx.model &&
						shouldLoadCodexUsage(ctx.model.provider, ctx.modelRegistry.isUsingOAuth(ctx.model), ctx.hasUI),
				),
			load: (signal) => load(ctx, signal),
			onUsage: (usage) => {
				const status = codexUsageStatusText(ctx.model?.provider, usage, enabled);
				ctx.ui.setStatus(STATUS_KEY, status ? ctx.ui.theme.fg("dim", status) : undefined);
			},
			onError: () => {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", UNAVAILABLE_STATUS));
				console.error("[chatgpt-subscription-usage] Refresh failed");
			},
		});
	};

	pi.registerCommand("usage", {
		description: "Toggle OpenAI Codex usage in the footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			restart(ctx);
			ctx.ui.notify(`Provider usage: ${enabled ? "shown" : "hidden"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = true;
		restart(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		restart(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
