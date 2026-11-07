/**
 * senpi#4267: `get_state` and `get_entries` are side-effect-free reads, so a marked one is an observing read
 * like `get_protocol_info` and `list_sessions`; unmarked, they attach as before. Protocol contract.
 */
import { describe, expect, it } from "vitest";
import { isObservingRequest } from "./host-observe-request.ts";

describe("observing reads (senpi#4267)", () => {
	it.each(["get_state", "get_entries"])("get_state observe: a marked %s is an observing read", (type) => {
		expect(isObservingRequest(JSON.stringify({ type, sessionId: "s1", observe: true }))).toBe(true);
	});

	it.each(["get_state", "get_entries"])("an unmarked %s is not an observing read", (type) => {
		expect(isObservingRequest(JSON.stringify({ type, sessionId: "s1" }))).toBe(false);
		expect(isObservingRequest(JSON.stringify({ type, sessionId: "s1", observe: "true" }))).toBe(false);
	});

	it("still ignores observe on a command that is not a read", () => {
		expect(isObservingRequest(JSON.stringify({ type: "prompt", sessionId: "s1", message: "x", observe: true }))).toBe(
			false,
		);
	});
});
