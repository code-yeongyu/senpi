import assert from "node:assert/strict";
import test from "node:test";
import { collectors } from "../../scenarios/fused-equivalence/cases/support/collectors.mjs";

const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "proxy-authorization", "cookie", "api-key", "x-goog-api-key"];
const o4 = (headers) => collectors.O4({ server: { requests: [{ method: "POST", url: "/v1/messages", headers }] } })[0];

test("O4 renders a credential header as a redacted hash, never the value or a bare hash", () => {
	const value = ["test", "not", "a", "key", "o4"].join("-");
	const out = o4({ ...Object.fromEntries(CREDENTIAL_HEADERS.map((name) => [name, value])), "content-type": "text/plain" });
	for (const name of CREDENTIAL_HEADERS) {
		assert.match(out[name], /^<redacted:sha256:[0-9a-f]{16}>$/, name);
		assert.ok(!out[name].includes(value), name);
	}
	assert.equal(out["content-type"], "text/plain");
});

test("O4 redaction keeps the hash: different keys differ, equal keys match", () => {
	const headers = (key) => ({ "x-api-key": key, authorization: `Bearer ${key}` });
	const first = o4(headers(["first", "value"].join("-")));
	const second = o4(headers(["second", "value"].join("-")));
	assert.notEqual(first["x-api-key"], second["x-api-key"]);
	assert.notEqual(first.authorization, second.authorization);
	assert.deepEqual(o4(headers(["first", "value"].join("-"))), first);
});
