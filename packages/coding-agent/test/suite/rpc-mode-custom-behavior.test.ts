import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCustomUnsupportedRequest, CUSTOM_UNSUPPORTED_CAPABILITY } from "../../src/modes/rpc/custom-capability.ts";

// Characterization coverage for the capability-gated RPC ctx.ui.custom behavior.
// Default clients receive no wire request; clients that advertise the capability
// receive one additive custom_unsupported extension UI request.

const thisDir = dirname(fileURLToPath(import.meta.url));
const connectionHandlerPath = join(thisDir, "..", "..", "src", "modes", "rpc", "connection-handler.ts");

/** Extract the body of the `async custom() { ... }` method from connection-handler.ts. */
function extractCustomBody(source: string): string {
	const marker = "async custom() {";
	const start = source.indexOf(marker);
	if (start === -1) throw new Error("async custom() not found in connection-handler.ts");
	const bodyStart = start + marker.length;
	let depth = 1;
	let index = bodyStart;
	while (index < source.length && depth > 0) {
		const ch = source[index];
		if (ch === "{") depth += 1;
		else if (ch === "}") depth -= 1;
		index += 1;
	}
	return source.slice(bodyStart, index - 1).trim();
}

describe("rpc-mode ctx.ui.custom characterization", () => {
	it("source: async custom() returns undefined and gates the notice on the capability flag", () => {
		const source = readFileSync(connectionHandlerPath, "utf-8");
		const body = extractCustomBody(source);

		// Still returns undefined.
		expect(body).toContain("return undefined as never");
		// The emission is GATED through the pure gate helper — no unconditional
		// output(): the only output happens inside the `if (request)` guard.
		expect(body).toContain("buildCustomUnsupportedRequest");
		expect(body).toContain("if (request)");
	});

	it("behavior (unflagged): the gate yields no request — byte-identical default", () => {
		// A default client sends no capabilities: the gate returns undefined, so the
		// handler emits NOTHING and custom() resolves to undefined.
		expect(buildCustomUnsupportedRequest(undefined, "ext")).toBeUndefined();
		expect(buildCustomUnsupportedRequest([], "ext")).toBeUndefined();
	});

	it("behavior (flagged): the gate yields exactly one additive custom_unsupported request", () => {
		const request = buildCustomUnsupportedRequest([CUSTOM_UNSUPPORTED_CAPABILITY], "third-party-ext");
		expect(request).toMatchObject({
			type: "extension_ui_request",
			method: "custom_unsupported",
			extensionName: "third-party-ext",
		});
	});
});
