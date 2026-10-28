import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostCloses, next, peerRecord } from "./host-cli-presenter-support.ts";
import { Peer, type Wire } from "./rpc-public-auth-harness.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function channel(): Promise<{ host: Socket; client: Socket }> {
	const dir = await mkdtemp(join(tmpdir(), "hcp-waits-"));
	const server: Server = createServer();
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	server.listen(join(dir, "s"));
	await once(server, "listening");
	cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
	const accepted = once(server, "connection");
	const client = connect(join(dir, "s"));
	await once(client, "connect");
	const [host] = (await accepted) as [Socket];
	cleanups.push(async () => {
		client.destroy();
		host.destroy();
	});
	return { host, client };
}

const waits: { name: string; start: (client: Socket, signal: AbortSignal) => Promise<Wire> }[] = [
	{ name: "next", start: (client, signal) => next(client, "host_superseded", signal) },
	{
		name: "peerRecord",
		start: (client, signal) =>
			peerRecord(new Peer(client), (record) => record.type === "host_superseded", "host_superseded", signal),
	},
];

describe.skipIf(process.platform === "win32")("presenter test waits end on events, never on a window (#4652)", () => {
	it.each(waits)("$name resolves with the record after others", async ({ start }) => {
		const { host, client } = await channel();
		const waiting = start(client, new AbortController().signal);
		host.write(`${JSON.stringify({ type: "agent_end" })}\n${JSON.stringify({ type: "host_superseded" })}\n`);
		await expect(waiting).resolves.toMatchObject({ type: "host_superseded" });
	});

	it.each(waits)("$name fails as closed only when the channel closes", async ({ start }) => {
		const { host, client } = await channel();
		const waiting = start(client, new AbortController().signal);
		host.end(`${JSON.stringify({ type: "agent_end" })}\n`);
		await expect(waiting).rejects.toThrow(/closed before host_superseded.*agent_end/);
	});

	it.each(waits)("$name fails as still waiting, channel open, when the test ends", async ({ start }) => {
		const { client } = await channel();
		const test = new AbortController();
		const waiting = start(client, test.signal);
		test.abort();
		await expect(waiting).rejects.toThrow(/still waiting for host_superseded when the test ended.*open/);
		expect(client.destroyed).toBe(false);
	});

	it("hostCloses resolves on the host's close and reports a test that ends first", async () => {
		const closing = await channel();
		const closed = hostCloses(closing.client, "the channel", new AbortController().signal);
		closing.host.end();
		await expect(closed).resolves.toBeUndefined();
		const open = await channel();
		const test = new AbortController();
		const waiting = hostCloses(open.client, "the channel", test.signal);
		test.abort();
		await expect(waiting).rejects.toThrow("still waiting for the host to close the channel when the test ended");
	});
});
