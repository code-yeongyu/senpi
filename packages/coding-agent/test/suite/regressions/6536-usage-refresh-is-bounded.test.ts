import { describe, expect, it } from "vitest";
import { isDue, type UsageCacheFile } from "../../../src/core/subscription-limits/usage-cache.ts";

// senpi#6536: a person's turn on a held provider re-reads its accounts' usage before the next interval, but never
// sooner than a minute after the last reading, and never early on an account whose endpoint asked to be left alone.
const KEY = "anthropic-subscription/main";
const MINUTE = 60_000;

function cacheWith(reading: UsageCacheFile["accounts"][string]): UsageCacheFile {
	return { accounts: { [KEY]: reading }, fetching: {} };
}

describe("a forced usage refresh stays bounded (senpi#6536)", () => {
	const healthy = cacheWith({ windows: [], updatedAt: 0, nextAt: 5 * MINUTE });

	it("re-reads a healthy reading a minute old before its interval", () => {
		expect(isDue(healthy, KEY, MINUTE)).toBe(false);
		expect(isDue(healthy, KEY, MINUTE, MINUTE)).toBe(true);
	});

	it("does not re-read a reading younger than a minute", () => {
		expect(isDue(healthy, KEY, MINUTE - 1, MINUTE)).toBe(false);
	});

	it("keeps a failed reading's backoff", () => {
		const limited = cacheWith({ windows: [], error: "rate limited", updatedAt: 0, nextAt: 30 * MINUTE });
		expect(isDue(limited, KEY, 10 * MINUTE, MINUTE)).toBe(false);
	});

	it("never reads while another process holds a live claim", () => {
		const claimed: UsageCacheFile = { ...healthy, fetching: { [KEY]: { claimedAt: MINUTE, token: "other" } } };
		expect(isDue(claimed, KEY, MINUTE + 1, MINUTE)).toBe(false);
	});
});
