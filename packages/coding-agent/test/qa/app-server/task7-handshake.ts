import assert from "node:assert/strict";
import type { RpcEnvelope } from "../../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";

const sent: RpcEnvelope[] = [];
const core = new ServerCore();
const connection = core.addConnection({
	id: "qa-handshake",
	transportKind: "stdio",
	send: (message) => {
		sent.push(message);
	},
	close: () => undefined,
});

await core.receive(connection.id, {
	kind: "request",
	message: {
		id: 1,
		method: "initialize",
		params: { clientInfo: { name: "qa", title: "QA", version: "0.0.1" } },
	},
});
await core.receive(connection.id, { kind: "notification", message: { method: "initialized", params: {} } });

const response = sent[0];
assert.ok(response);
assert.ok("result" in response);
assert.equal(response.id, 1);
assert.equal("jsonrpc" in response, false);
assert.ok(isRecord(response.result));
assert.deepEqual(
	Object.keys(response.result).sort(),
	["codexHome", "platformFamily", "platformOs", "userAgent"].sort(),
);
assert.equal("protocolVersion" in response.result, false);
const userAgent = response.result.userAgent;
if (typeof userAgent !== "string") {
	throw new Error("initialize response userAgent must be a string");
}
assert.ok(userAgent.startsWith("qa/"));
console.log(JSON.stringify(response));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
