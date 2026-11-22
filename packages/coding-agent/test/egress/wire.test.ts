import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { OpenAiCompactBody } from "../../src/core/extensions/builtin/compaction/openai-remote-schema.ts";
import type { SignedPlacementClaim } from "../../src/core/egress/placement-claim.ts";
import {
	type CustodyRefreshRequest,
	type HandLocalStreamOptionKey,
	type HookModelRequest,
	PROVIDER_CALL_ERROR_CODES,
	type ProviderCallError,
	type ProviderCallHooked,
	type ProviderCallResultQuery,
	type ProviderCallStart,
	WIRE_STREAM_OPTION_KEYS,
	type WireStreamOptions,
} from "../../src/core/egress/wire.ts";

/** Keys that stay on the brain: secrets and headers (design 4.3), callbacks and live objects, and host-local values. */
const HAND_LOCAL = [
	"apiKey",
	"cwd",
	"env",
	"fetch",
	"headers",
	"onPayload",
	"onProviderStreamEvent",
	"onResponse",
	"onTransportActivity",
	"signal",
	"telemetryContext",
] as const;

const WIRE = [
	"abortServerSideFallback",
	"affinitySessionId",
	"cacheRetention",
	"deferred",
	"extraBody",
	"maxRetries",
	"maxRetryDelayMs",
	"maxTokens",
	"metadata",
	"reasoning",
	"refusalFallbacks",
	"samplingParams",
	"serviceTier",
	"sessionAffinityKey",
	"sessionId",
	"streamKind",
	"temperature",
	"thinkingBudgets",
	"thinkingSelection",
	"timeoutMs",
	"toolChoice",
	"transport",
	"websocketConnectTimeoutMs",
] as const;

describe("WireStreamOptions allowlist (custody design 4.3, 2.3 options hygiene)", () => {
	it("classifies every SimpleStreamOptions key as wire or hand-local, with no overlap", () => {
		expectTypeOf<HandLocalStreamOptionKey>().toEqualTypeOf<(typeof HAND_LOCAL)[number]>();
		expectTypeOf<keyof WireStreamOptions>().toEqualTypeOf<(typeof WIRE)[number]>();
		expectTypeOf<
			Exclude<keyof SimpleStreamOptions, keyof WireStreamOptions | HandLocalStreamOptionKey>
		>().toBeNever();
		expect([...WIRE_STREAM_OPTION_KEYS].sort()).toEqual([...WIRE]);
		expect(WIRE_STREAM_OPTION_KEYS.filter((key) => (HAND_LOCAL as readonly string[]).includes(key))).toEqual([]);
	});

	it("never carries the keys design 4.3 forbids, including the loop-only commitStep and cursor callbacks", () => {
		const forbidden = ["apiKey", "headers", "signal", "onPayload", "execHandlers", "onToolResult", "commitStep"];
		expectTypeOf<Extract<keyof WireStreamOptions, "commitStep" | "execHandlers" | "onToolResult">>().toBeNever();
		expect(WIRE_STREAM_OPTION_KEYS.filter((key) => forbidden.includes(key))).toEqual([]);
	});
});

describe("provider.call messages (custody design 4.3, 15.14, 15.15)", () => {
	it("the error code union is exactly the twelve codes, claim_invalid included", () => {
		expectTypeOf<ProviderCallError["code"]>().toEqualTypeOf<(typeof PROVIDER_CALL_ERROR_CODES)[number]>();
		expect([...PROVIDER_CALL_ERROR_CODES].sort()).toEqual([
			"aborted",
			"auth",
			"claim_expired",
			"claim_invalid",
			"definition_mismatch",
			"local_only_unsupported",
			"rate_limited",
			"registry_key_revoked",
			"registry_key_unknown",
			"stale_epoch",
			"unavailable",
			"unknown_provider",
		]);
	});

	it("an aux call carries one of three aux kinds; the request is a stream request or a compact body only", () => {
		type AuxCall = Extract<ProviderCallStart["call"], { readonly kind: "aux" }>;
		expectTypeOf<AuxCall["auxKind"]>().toEqualTypeOf<"stream" | "warm" | "compact-endpoint">();
		expectTypeOf<ProviderCallStart["call"]["kind"]>().toEqualTypeOf<"step" | "aux">();
		expectTypeOf<Extract<ProviderCallStart["request"], { readonly compactBody: unknown }>>().toEqualTypeOf<{
			readonly compactBody: OpenAiCompactBody;
		}>();
		expectTypeOf<
			Exclude<ProviderCallStart["request"], { readonly compactBody: unknown }>["options"]
		>().toEqualTypeOf<WireStreamOptions>();
	});

	it("hooked is seq 0 and carries the post-hook request", () => {
		expectTypeOf<ProviderCallHooked["seq"]>().toEqualTypeOf<0>();
		expectTypeOf<ProviderCallHooked["request"]>().toEqualTypeOf<ProviderCallStart["request"]>();
	});

	it("every brain-to-hand request that causes execution carries a signed placement claim", () => {
		expectTypeOf<ProviderCallStart["claim"]>().toEqualTypeOf<SignedPlacementClaim>();
		expectTypeOf<ProviderCallResultQuery["claim"]>().toEqualTypeOf<SignedPlacementClaim>();
		expectTypeOf<HookModelRequest["claim"]>().toEqualTypeOf<SignedPlacementClaim>();
		expectTypeOf<CustodyRefreshRequest["claim"]>().toEqualTypeOf<SignedPlacementClaim>();
	});
});
