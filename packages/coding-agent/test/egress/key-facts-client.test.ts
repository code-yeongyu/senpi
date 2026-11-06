import { describe, expect, it } from "vitest";
import { UNANCHORED_KEY_FACTS_READER } from "../../src/core/egress/key-facts-client.ts";

describe("UNANCHORED_KEY_FACTS_READER", () => {
	it("answers unknown for every key until the facts channel has a shipped trust anchor", async () => {
		expect(
			await UNANCHORED_KEY_FACTS_READER.describe(
				"arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000001",
			),
		).toBe("unknown");
	});
});
