/**
 * Neo daemon handshake protocol parsing + validation.
 */

import { describe, expect, it } from "vitest";
import { parseHello, validateHello } from "../src/modes/rpc/neo-daemon-protocol.ts";

describe("parseHello", () => {
	it("parses a well-formed hello", () => {
		const hello = parseHello(
			JSON.stringify({ type: "hello", token: "t", version: 1, capabilities: ["x"], runtimeOptions: { model: "m" } }),
		);
		expect(hello).toEqual({
			type: "hello",
			token: "t",
			version: 1,
			capabilities: ["x"],
			runtimeOptions: { model: "m" },
		});
	});

	it("rejects non-hello / malformed lines", () => {
		expect(parseHello("not json")).toBeUndefined();
		expect(parseHello(JSON.stringify({ type: "prompt" }))).toBeUndefined();
		expect(parseHello(JSON.stringify({ type: "hello", version: 1 }))).toBeUndefined(); // no token
		expect(parseHello(JSON.stringify({ type: "hello", token: "t" }))).toBeUndefined(); // no version
		expect(parseHello(JSON.stringify({ type: "hello", token: "t", version: 1, capabilities: "no" }))).toBeUndefined();
	});
});

describe("validateHello", () => {
	const hello = { type: "hello" as const, token: "good", version: 1 };

	it("accepts a matching token + version", () => {
		expect(validateHello(hello, { token: "good", version: 1 })).toBeUndefined();
	});

	it("refuses a version mismatch", () => {
		const refusal = validateHello({ ...hello, version: 2 }, { token: "good", version: 1 });
		expect(refusal).toMatchObject({ type: "refuse", code: "version_mismatch" });
	});

	it("refuses a bad token", () => {
		const refusal = validateHello({ ...hello, token: "bad" }, { token: "good", version: 1 });
		expect(refusal).toMatchObject({ type: "refuse", code: "bad_token" });
	});

	it("checks version before token", () => {
		// A wrong token AND wrong version reports version_mismatch first.
		const refusal = validateHello({ ...hello, token: "bad", version: 5 }, { token: "good", version: 1 });
		expect(refusal).toMatchObject({ code: "version_mismatch" });
	});
});
