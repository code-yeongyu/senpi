import assert from "node:assert/strict";
import type { RpcEnvelope } from "../../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";

const sent: RpcEnvelope[] = [];
const core = new ServerCore();
const connection = core.addConnection({
	id: "qa-preinit",
	transportKind: "stdio",
	send: (message) => {
		sent.push(message);
	},
	close: () => undefined,
});

await core.receive(connection.id, {
	kind: "request",
	message: {
		id: 9,
		method: "thread/list",
		params: {},
	},
});

const response = sent[0];
assert.ok(response);
assert.ok("error" in response);
assert.equal(response.id, 9);
assert.equal(response.error.message, "Not initialized");
console.log(JSON.stringify(response));
