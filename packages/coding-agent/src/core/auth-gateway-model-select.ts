import type { AuthGatewayAuthorizedModel } from "./auth-gateway-observability.ts";

export function modelForRequest(
	models: readonly AuthGatewayAuthorizedModel[],
	body: unknown,
	modelField: "model" | "modelId",
): AuthGatewayAuthorizedModel | undefined {
	if (!isRecord(body) || !(modelField in body)) return undefined;
	const requested = body[modelField];
	if (typeof requested !== "string") return undefined;
	const separator = requested.indexOf("/");
	if (separator > 0) {
		const provider = requested.slice(0, separator);
		const modelId = requested.slice(separator + 1);
		return models.find((model) => model.provider === provider && model.modelId === modelId);
	}
	const matches = models.filter((model) => model.modelId === requested);
	return matches.length === 1 ? matches[0] : undefined;
}

export function qualifyModel(
	body: unknown,
	modelField: "model" | "modelId",
	model: AuthGatewayAuthorizedModel,
): unknown {
	if (!isRecord(body)) return body;
	return { ...body, [modelField]: `${model.provider}/${model.modelId}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
