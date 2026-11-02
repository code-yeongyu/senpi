import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acknowledgedRequest, hostCloses, next, peerRecord } from "./host-cli-presenter-support.ts";
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

	const queued = { type: "queued", for_request: "open", position: 1, in_flight: 0 };
	const answer = { type: "response", id: "open", command: "open_session", success: true };
	it.each([
		{ order: "queued, then the answer", records: [queued, answer], outcome: "resolves" },
		{ order: "the answer alone", records: [answer], outcome: "rejects" },
		{ order: "the answer, then queued", records: [answer, queued], outcome: "rejects" },
		{
			order: "another request's queued, then the answer",
			records: [{ ...queued, for_request: "x" }, answer],
			outcome: "rejects",
		},
	])("acknowledgedRequest $outcome for $order", async ({ records, outcome }) => {
		const { host, client } = await channel();
		const waiting = acknowledgedRequest(
			new Peer(client),
			{ id: "open", type: "open_session" },
			new AbortController().signal,
		);
		host.write(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
		if (outcome === "resolves") await expect(waiting).resolves.toMatchObject(answer);
		else
			await expect(waiting).rejects.toThrow("open_session was answered without a queued acknowledgement before it");
	});

	it.each(["ECONNRESET", "EIO"])("hostCloses accepts only a reset before close (%s)", async (code) => {
		const { client } = await channel();
		const closed = hostCloses(client, "the channel", new AbortController().signal);
		client.destroy(Object.assign(new Error("channel error"), { code }));
		if (code === "ECONNRESET") await expect(closed).resolves.toBeUndefined();
		else await expect(closed).rejects.toThrow("the channel failed before the host closed it: channel error");
	});

	it("hostCloses still requires close after a reset", async () => {
		const { client } = await channel();
		const test = new AbortController();
		const closed = hostCloses(client, "the channel", test.signal);
		client.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
		test.abort();
		await expect(closed).rejects.toThrow("still waiting for the host to close the channel when the test ended");
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
