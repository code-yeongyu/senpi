// senpi#5840: the hand's socket carrier keeps the transport's CarrierConnection contract: `send` returns false (not
// taken) while the socket is over its high-water mark, so the side resends after `writable()` instead of the line
// being queued twice.
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { attachSocketCarrier, type CarrierSide } from "../../../src/modes/hand/socket-carrier.ts";
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function socketPair(): Promise<{ readonly local: Socket; readonly remote: Socket }> {
	const dir = mkdtempSync(join("/tmp", "s5840c-"));
	const path = join(dir, "c.sock");
	const server: Server = createServer();
	const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
	await new Promise<void>((resolve) => server.listen(path, resolve));
	const local = createConnection(path);
	await new Promise<void>((resolve) => local.once("connect", resolve));
	const remote = await accepted;
	remote.pause();
	cleanups.push(() => {
		local.destroy();
		remote.destroy();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { local, remote };
}

it("refuses a send while the socket is over its high-water mark and takes it once drained", async () => {
	const { local, remote } = await socketPair();
	let connection: Parameters<CarrierSide["attached"]>[0] | undefined;
	const writable = Promise.withResolvers<void>();
	attachSocketCarrier(
		local,
		{
			attached: (attachedConnection) => {
				connection = attachedConnection;
			},
			message: () => {},
			writable: () => writable.resolve(),
			detached: () => {},
		},
		() => {},
	);
	if (connection === undefined) throw new Error("carrier never attached");
	const ack = { kind: "ack", lane: "scope-1", seq: 1 };

	expect(connection.send(ack)).toBe(true);
	while (!local.writableNeedDrain) local.write(Buffer.alloc(1024 * 1024));
	expect(connection.send(ack)).toBe(false);

	remote.resume();
	await writable.promise;
	expect(connection.send(ack)).toBe(true);
});

it("reports a carrier socket error once per connection, then destroys the socket", async () => {
	const { local } = await socketPair();
	const reported: string[] = [];
	attachSocketCarrier(
		local,
		{ attached: () => {}, message: () => {}, writable: () => {}, detached: () => {} },
		(line) => reported.push(line),
	);
	const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

	local.emit("error", error);
	local.emit("error", error);

	expect(reported).toEqual(["carrier socket error ECONNRESET: read ECONNRESET"]);
	expect(local.destroyed).toBe(true);
});
