import { describe, expect, it } from "vitest";
import * as slotsNamespace from "../src/auth/pool/slots.ts";
import { isManagedSentinelSlot } from "../src/auth/pool/slots.ts";
import { normalizeProviderId } from "../src/legacy-provider-ids.ts";
import type { Api, Model } from "../src/types.ts";
import { resolvePromptCacheTtlSeconds } from "../src/utils/prompt-cache-ttl.ts";

/**
 * Provider rename: `claude-sdk-oauth` -> `anthropic-subscription` (display name
 * "Claude SDK OAuth" -> "Anthropic Subscription"). The wire api id
 * `claude-sdk-oauth` is intentionally FROZEN (see
 * packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/api-id.ts),
 * and so is every persisted token derived from the old provider id: stored
 * credentials still carry the managed-sentinel material `claude-sdk-oauth-managed`
 * verbatim, so matchers must accept BOTH the canonical and the legacy material.
 */

describe("anthropic-subscription provider rename", () => {
	it("normalizes the legacy claude-sdk-oauth id to anthropic-subscription", () => {
		expect(normalizeProviderId("claude-sdk-oauth")).toBe("anthropic-subscription");
		expect(normalizeProviderId("anthropic-subscription")).toBe("anthropic-subscription");
	});

	it("exposes a widened managedSentinelMaterials helper", () => {
		expect(typeof slotsNamespace.managedSentinelMaterials).toBe("function");
	});

	it("matches BOTH the canonical and the legacy managed-sentinel material under the new id", () => {
		// Stored credentials written by older builds keep `claude-sdk-oauth-managed`
		// verbatim; a matcher keyed only on the new provider id would stop
		// recognizing those slots and the poisoned-slot repair would silently die.
		expect(
			isManagedSentinelSlot("anthropic-subscription", {
				name: "login-1",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
			}),
		).toBe(true);
		expect(
			isManagedSentinelSlot("anthropic-subscription", {
				name: "login-1",
				access: "anthropic-subscription-managed",
				refresh: "anthropic-subscription-managed",
			}),
		).toBe(true);
	});

	it("does not widen the sentinel match across unrelated providers", () => {
		expect(
			isManagedSentinelSlot("other-provider", {
				name: "login-1",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
			}),
		).toBe(false);
		expect(
			isManagedSentinelSlot("anthropic-subscription", {
				name: "login-1",
				access: "real-access",
				refresh: "claude-sdk-oauth-managed",
			}),
		).toBe(false);
	});

	it("keeps the wire api id frozen on the prompt-cache ttl table", () => {
		expect(resolvePromptCacheTtlSeconds({ api: "claude-sdk-oauth" } as Model<Api>)).toBe(300);
	});
});
