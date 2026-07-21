import type {
	FuzzyFileSearchParams,
	FuzzyFileSearchSessionStartParams,
	FuzzyFileSearchSessionStopParams,
	FuzzyFileSearchSessionUpdateParams,
} from "../protocol/fuzzy-search.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import type { MethodRegistry } from "../rpc/registry.ts";
import type { FuzzyFileSearchService } from "./fuzzy-search-service.ts";

export function registerFuzzyFileSearchMethods(registry: MethodRegistry, service: FuzzyFileSearchService): void {
	registry.register("fuzzyFileSearch", {
		scope: "global",
		handler: ({ request }) => service.search(parseOneShotParams(request.params)),
	});
	registry.register("fuzzyFileSearch/sessionStart", {
		experimental: true,
		scope: "global",
		handler: ({ request }) => service.startSession(parseSessionStartParams(request.params)),
	});
	registry.register("fuzzyFileSearch/sessionUpdate", {
		experimental: true,
		scope: "global",
		handler: ({ request }) => service.updateSession(parseSessionUpdateParams(request.params)),
	});
	registry.register("fuzzyFileSearch/sessionStop", {
		experimental: true,
		scope: "global",
		handler: ({ request }) => service.stopSession(parseSessionStopParams(request.params)),
	});
}

function parseOneShotParams(value: unknown): FuzzyFileSearchParams {
	const params = objectParams(value, "fuzzyFileSearch");
	return {
		query: requiredString(params.query, "fuzzyFileSearch query"),
		roots: requiredStringArray(params.roots, "fuzzyFileSearch roots"),
		cancellationToken: optionalString(params.cancellationToken, "fuzzyFileSearch cancellationToken"),
	};
}

function parseSessionStartParams(value: unknown): FuzzyFileSearchSessionStartParams {
	const params = objectParams(value, "fuzzyFileSearch/sessionStart");
	return {
		sessionId: requiredString(params.sessionId, "fuzzyFileSearch/sessionStart sessionId"),
		roots: requiredStringArray(params.roots, "fuzzyFileSearch/sessionStart roots"),
	};
}

function parseSessionUpdateParams(value: unknown): FuzzyFileSearchSessionUpdateParams {
	const params = objectParams(value, "fuzzyFileSearch/sessionUpdate");
	return {
		sessionId: requiredString(params.sessionId, "fuzzyFileSearch/sessionUpdate sessionId"),
		query: requiredString(params.query, "fuzzyFileSearch/sessionUpdate query"),
	};
}

function parseSessionStopParams(value: unknown): FuzzyFileSearchSessionStopParams {
	const params = objectParams(value, "fuzzyFileSearch/sessionStop");
	return { sessionId: requiredString(params.sessionId, "fuzzyFileSearch/sessionStop sessionId") };
}

function objectParams(value: unknown, method: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalidRequest(`${method} params must be an object`);
	return value;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string") throw invalidRequest(`${field} must be a string`);
	return value;
}

function requiredStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw invalidRequest(`${field} must be an array of strings`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw invalidRequest(`${field} must be a string or null`);
	return value;
}

function invalidRequest(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
