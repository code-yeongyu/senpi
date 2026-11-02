import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import {
	cursorOverflowCompactionSettings,
	isContextOverflow,
	isCursorPayloadResourceExhausted,
	isCursorZeroTokenResourceExhausted,
	shouldSkipProviderFallbackForCursorZeroRe,
} from "../src/utils/overflow.ts";

const zeroRe: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "cursor",
	provider: "cursor",
	model: "composer-1.5",
	stopReason: "error",
	errorMessage: "Connect error resource_exhausted: Error",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 0,
};

describe("isCursorPayloadResourceExhausted", () => {
	it("treats 0-token Cursor RE as payload overflow even when estimate is zeroed", () => {
		expect(isContextOverflow(zeroRe, 1_000_000)).toBe(false);
		expect(isCursorPayloadResourceExhausted(zeroRe, 150_000)).toBe(true);
		expect(isCursorPayloadResourceExhausted(zeroRe, 0)).toBe(true);
		expect(isCursorZeroTokenResourceExhausted(zeroRe)).toBe(true);
		expect(shouldSkipProviderFallbackForCursorZeroRe({ sameModelRemint: true })).toBe(true);
		expect(
			cursorOverflowCompactionSettings({ keepRecentTokens: 20_000, restorationEnabled: true }, "cursor", "overflow")
				.keepRecentTokens,
		).toBe(0);
	});
});
