import type { Api } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "../types.js";

type ProviderPayload = Record<string, unknown>;

const OPENAI_PARALLEL_TOOL_CALL_APIS: ReadonlySet<Api> = new Set([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

function isRecord(value: unknown): value is ProviderPayload {
	return typeof value === "object" && value !== null;
}

function hasTools(payload: ProviderPayload): boolean {
	return Array.isArray(payload.tools) && payload.tools.length > 0;
}

export function addParallelToolCallsToPayload(api: Api | undefined, payload: unknown): unknown {
	if (!api || !OPENAI_PARALLEL_TOOL_CALL_APIS.has(api)) {
		return payload;
	}

	if (!isRecord(payload) || !hasTools(payload) || payload.parallel_tool_calls !== undefined) {
		return payload;
	}

	return {
		...payload,
		parallel_tool_calls: true,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		return addParallelToolCallsToPayload(ctx.model?.api, event.payload);
	});
}
