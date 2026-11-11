// CK21 byte-identity pin: the fused CLI's request-hook dispatch, written against APIs that exist before CK21 so the same
// file passes unchanged on the base commit and on the CK21 head.
import { describe, expect, it } from "vitest";
import { fusedDispatch, REQUEST_HEADERS, REQUEST_MODEL, REQUEST_PAYLOAD } from "./hook-request-fixture.ts";

describe("CK21: the fused request-hook dispatch is unchanged", () => {
	it("hands a user hook the payload, the effective model and the final headers, and sends what it returns", async () => {
		const { seen, result } = await fusedDispatch((seen) => (pi) => {
			pi.on("before_provider_request", (event) => {
				seen.push(structuredClone(event));
				return { ...(event.payload as object), max_tokens: 2048 };
			});
		});

		expect(seen).toEqual([
			{ type: "before_provider_request", payload: REQUEST_PAYLOAD, model: REQUEST_MODEL, headers: REQUEST_HEADERS },
		]);
		expect(Object.keys(seen[0] ?? {})).toEqual(["type", "payload", "model", "headers"]);
		expect(result).toEqual({ ...REQUEST_PAYLOAD, max_tokens: 2048 });
	});

	it("keeps the payload when no hook replaces it", async () => {
		const { seen, result } = await fusedDispatch((seen) => (pi) => {
			pi.on("before_provider_request", (event) => void seen.push(structuredClone(event)));
		});

		expect(seen).toHaveLength(1);
		expect(result).toEqual(REQUEST_PAYLOAD);
	});
});
