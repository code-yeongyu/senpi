/**
 * Checks an API key against its provider without storing it (desktop #2510): one cheap authenticated
 * read (the model list) with the key in memory only. The answer is `ok`, `rejected` (the provider
 * said 401/403), `unreachable` (no answer, 5xx, timeout) or `unsupported` (no probe for this API, or
 * the endpoint has no model list), so a client can say "we could not check" instead of guessing.
 * Neither the key nor the request headers ever reach a log, an error message or the result.
 */
import type { Api, Model } from "@earendil-works/pi-ai/compat";

import type { AuthProviderInfo } from "./auth-providers.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { getConfigValueEnvVarNames, isCommandConfigValue } from "./resolve-config-value.ts";

export type ApiKeyVerification =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "rejected" | "unreachable" | "unsupported" | "unknown-provider";
			readonly status?: number;
	  };

type Probe = { readonly url: string; readonly headers: Record<string, string> };

const trimSlash = (value: string) => value.replace(/\/+$/, "");

const UNCHECKABLE_CONTROL_KEY = "senpi-verify-control-not-a-real-key";

const AUTH_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key"]);

function probeFor(model: Model<Api>, key: string): Probe | undefined {
	const base = trimSlash(model.baseUrl);
	// Configured auth headers would be merged with (or replace) the probe's, whatever their case.
	const extra = Object.fromEntries(
		Object.entries(model.headers ?? {}).filter(([name]) => !AUTH_HEADERS.has(name.toLowerCase())),
	);
	switch (model.api) {
		case "openai-completions":
		case "openai-responses":
			return { url: `${base}/models`, headers: { ...extra, authorization: `Bearer ${key}` } };
		case "mistral-conversations":
			// The Mistral runtime calls `${base}/v1/...`; its model list lives there too.
			return {
				url: `${base.replace(/\/v1$/, "")}/v1/models`,
				headers: { ...extra, authorization: `Bearer ${key}` },
			};
		case "anthropic-messages":
			return {
				url: `${base.replace(/\/v1$/, "")}/v1/models`,
				headers: { ...extra, "x-api-key": key, "anthropic-version": "2023-06-01" },
			};
		case "google-generative-ai":
			return { url: `${base}/models`, headers: { ...extra, "x-goog-api-key": key } };
		default:
			return undefined;
	}
}

export async function verifyApiKey(input: {
	readonly models: readonly Model<Api>[];
	readonly provider: string;
	readonly key: string;
	readonly signal: AbortSignal;
	readonly fetch?: typeof globalThis.fetch;
}): Promise<ApiKeyVerification> {
	const model = input.models.find((candidate) => candidate.provider === input.provider);
	if (model === undefined) return { ok: false, reason: "unknown-provider" };
	if (probeFor(model, input.key) === undefined) return { ok: false, reason: "unsupported" };
	const ask = async (candidate: string): Promise<number | "no-answer"> => {
		const target = probeFor(model, candidate);
		if (target === undefined) return "no-answer";
		try {
			const response = await (input.fetch ?? globalThis.fetch)(target.url, {
				method: "GET",
				headers: target.headers,
				redirect: "manual",
				signal: input.signal,
			});
			await response.body?.cancel().catch(() => {});
			return response.status;
		} catch {
			return "no-answer";
		}
	};
	// A rate limit or an outage means "try again", never "cannot be checked".
	const temporary = (status: number | "no-answer"): ApiKeyVerification | undefined =>
		status === "no-answer"
			? { ok: false, reason: "unreachable" }
			: status === 429 || status >= 500
				? { ok: false, reason: "unreachable", status }
				: undefined;
	const status = await ask(input.key);
	if (status === "no-answer") return { ok: false, reason: "unreachable" };
	const failedFirst = temporary(status);
	if (failedFirst !== undefined) return failedFirst;
	if (status === 401 || status === 403) return { ok: false, reason: "rejected", status };
	if (status < 200 || status >= 300) return { ok: false, reason: "unsupported", status };
	// A model list that also answers a made-up key is public (OpenRouter, keyless local servers):
	// its 200 says nothing about this key.
	const control = await ask(UNCHECKABLE_CONTROL_KEY);
	if (control === 401 || control === 403) return { ok: true };
	const failedControl = temporary(control);
	if (failedControl !== undefined) return failedControl;
	return { ok: false, reason: "unsupported" };
}

/**
 * `{ keyHint }` for the api_key row of a provider whose key the app stored as a literal, long enough
 * that four characters reveal nothing useful. A command (`!...`) or `$ENV` reference is never hinted:
 * any slice of it would describe where the secret lives, not which key it is.
 */
export function storedKeyHint(
	modelRegistry: ModelRegistry,
	info: Pick<AuthProviderInfo, "id" | "authType">,
): { keyHint?: string } {
	if (info.authType !== "api_key") return {};
	const credential = modelRegistry.authStorage.get(info.id);
	if (credential?.type !== "api_key" || credential.key === undefined) return {};
	const key = credential.key;
	if (isCommandConfigValue(key) || getConfigValueEnvVarNames(key).length > 0 || key.length < 12) return {};
	return { keyHint: key.slice(-4) };
}
