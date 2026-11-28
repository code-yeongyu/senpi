import { once } from "node:events";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

it("does not hand a stdio host to the test while its CLI is still starting (#7075)", async () => {
	const gate = createServer();
	gate.listen(0, "127.0.0.1");
	await once(gate, "listening");
	const address = gate.address();
	if (address === null || typeof address === "string") throw new Error("expected TCP gate");
	const connected = once(gate, "connection");
	let handedOut = false;
	const starting = startWorkerHost(undefined, {
		node: true,
		preload: `
			import { connect } from "node:net";
			import { once } from "node:events";
			const gate = connect(${address.port}, "127.0.0.1");
			gate.resume();
			await once(gate, "end");`,
	}).then((host) => {
		handedOut = true;
		return host;
	});
	try {
		const [child] = await Promise.race([connected, starting.then(() => connected)]);
		const early = handedOut;
		child.end();
		const host = await starting;
		try {
			expect(early).toBe(false);
			expect((await host.request({ type: "get_protocol_info" })).success).toBe(true);
		} finally {
			await host.dispose();
		}
	} finally {
		gate.close();
	}
});
