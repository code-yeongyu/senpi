/**
 * Per-api facts the custody route decision reads (custody design 2.3 and 5, row CK5).
 *
 * `capability` says where a call of this api can run; `fetchInjection` is "yes" only when every
 * request of the api goes through the `fetch` the caller injects (otherwise the sealed route could
 * not supply the key below the seam, so the call goes to a device); `sdkLogging` is the knob that
 * turns the api's SDK logging off. An api missing from the table (an extension-registered one) is
 * treated as an ambient-credential api with unknown fetch injection, which routes it to a device.
 */

import type { KnownApi } from "@earendil-works/pi-ai";
import type { ProviderCapability } from "./classify.ts";

export type FetchInjection = "yes" | "no" | "unknown";

export type SdkLoggingKnob =
	| { readonly kind: "none" }
	| { readonly kind: "client-option"; readonly option: "logLevel"; readonly off: "off" }
	| { readonly kind: "unknown" };

export interface ApiFacts {
	readonly capability: ProviderCapability;
	readonly fetchInjection: FetchInjection;
	readonly sdkLogging: SdkLoggingKnob;
}

const NO_SDK_LOGGER: SdkLoggingKnob = { kind: "none" };
const SDK_LOG_LEVEL_OFF: SdkLoggingKnob = { kind: "client-option", option: "logLevel", off: "off" };

export const API_FACTS = {
	"openai-completions": { capability: "cloud", fetchInjection: "yes", sdkLogging: SDK_LOG_LEVEL_OFF },
	"openai-responses": { capability: "cloud", fetchInjection: "no", sdkLogging: SDK_LOG_LEVEL_OFF },
	"azure-openai-responses": { capability: "cloud", fetchInjection: "yes", sdkLogging: SDK_LOG_LEVEL_OFF },
	"openai-codex-responses": { capability: "cloud", fetchInjection: "no", sdkLogging: NO_SDK_LOGGER },
	"mistral-conversations": { capability: "cloud", fetchInjection: "yes", sdkLogging: NO_SDK_LOGGER },
	"anthropic-messages": { capability: "cloud", fetchInjection: "yes", sdkLogging: SDK_LOG_LEVEL_OFF },
	"pi-messages": { capability: "cloud", fetchInjection: "yes", sdkLogging: NO_SDK_LOGGER },
	"google-generative-ai": { capability: "cloud", fetchInjection: "no", sdkLogging: NO_SDK_LOGGER },
	"google-vertex": { capability: "ambient-credential", fetchInjection: "no", sdkLogging: NO_SDK_LOGGER },
	"bedrock-converse-stream": {
		capability: "ambient-credential",
		fetchInjection: "no",
		sdkLogging: { kind: "unknown" },
	},
	"devin-agent": { capability: "cloud", fetchInjection: "no", sdkLogging: NO_SDK_LOGGER },
	"cursor-agent": { capability: "callback-stream", fetchInjection: "no", sdkLogging: NO_SDK_LOGGER },
} as const satisfies Record<KnownApi, ApiFacts>;

const UNKNOWN_API: ApiFacts = {
	capability: "ambient-credential",
	fetchInjection: "unknown",
	sdkLogging: { kind: "unknown" },
};

function isTabledApi(api: string): api is KnownApi {
	return Object.hasOwn(API_FACTS, api);
}

export function apiFacts(api: string | undefined): ApiFacts {
	return api !== undefined && isTabledApi(api) ? API_FACTS[api] : UNKNOWN_API;
}
