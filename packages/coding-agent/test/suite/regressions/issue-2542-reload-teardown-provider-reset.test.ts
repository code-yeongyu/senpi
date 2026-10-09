import { describe, expect, it } from "vitest";
import { promptDuringReloadTeardown } from "../config-reload-teardown-support.ts";

// senpi#2542: the reload's provider-registry reset dropped the caller's provider, and an API id that
// read like a transient failure turned the missing provider into a retry backoff past the timeout.
describe("issue 2542: prompt submitted during reload teardown", () => {
	it("answers once even when the provider id reads like a transient failure", async () => {
		// Given/When: the provider's API id contains a word the retry classifier treats as transient.
		const result = await promptDuringReloadTeardown("faux-overloaded");
		// Then: the rebuilt runtime still reaches that provider, so nothing is retried or delayed.
		expect(result.order).toEqual(["runtime rebuilt", "request started"]);
		expect(result.replies).toEqual(["Request after reload completed."]);
		expect(result.providerRequests).toBe(1);
	});
});
