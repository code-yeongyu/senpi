// senpi#3566 todo 4: the private channel is the tool child's only protocol path (never stdout).
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSocketSecret, resolveSocketTransportAddress, sendSocketHandshake } from "../socket-transport.ts";
import {
	channelEnvPresent,
	connectChannel,
	openChannelListener,
	TOOL_CHILD_CHANNEL_ENV,
	TOOL_CHILD_SECRET_ENV,
	type ToolChildChannel,
} from "./channel.ts";
import type { ToolChildMessage } from "./protocol.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "tcc-"));
	roots.push(root);
	return join(root, "ch");
}

function nextMessage(channel: ToolChildChannel): Promise<ToolChildMessage> {
	return new Promise((resolve) => channel.onMessage(resolve));
}

describe("tool-child channel", () => {
	it("carries frames both ways between one authenticated child and the server", async () => {
		const listener = await openChannelListener({ dir: await scratch(), generation: 3 });
		const child = await connectChannel(listener.env);
		const server = await listener.accepted;
		const atServer = nextMessage(server);
		child.send({ type: "hello", generation: 3, pid: process.pid, protocol: 2, jobKinds: ["module"] });
		expect(await atServer).toEqual({
			type: "hello",
			generation: 3,
			pid: process.pid,
			protocol: 2,
			jobKinds: ["module"],
		});
		const big = "x".repeat(3 * 1024 * 1024);
		const atChild = nextMessage(child);
		server.send({ type: "host_reply", callId: "c1", value: big });
		expect(await atChild).toEqual({ type: "host_reply", callId: "c1", value: big });
		child.close();
		expect(await server.closed).toEqual({ kind: "eof" });
		await listener.close();
	});

	it("keeps the channel directory private and removes its secret on close", async () => {
		const dir = await scratch();
		const listener = await openChannelListener({ dir, generation: 1 });
		if (process.platform !== "win32") expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect((await stat(listener.env[TOOL_CHILD_SECRET_ENV])).mode & 0o077).toBe(0);
		await listener.close();
		await expect(stat(listener.env[TOOL_CHILD_SECRET_ENV])).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("never accepts a peer without the secret, and accepts no second child", async () => {
		const listener = await openChannelListener({ dir: await scratch(), generation: 2 });
		const intruder = createConnection(
			resolveSocketTransportAddress(listener.env[TOOL_CHILD_CHANNEL_ENV], process.platform),
		);
		const intruderClosed = new Promise<void>((resolve) => intruder.once("close", () => resolve()));
		intruder.on("error", () => {});
		intruder.write(Buffer.alloc(32, 7));
		await intruderClosed;
		const child = await connectChannel(listener.env);
		await listener.accepted;
		await expect(connectChannel(listener.env)).rejects.toThrow();
		child.close();
		await listener.close();
	});

	it("closes on a malformed frame instead of resynchronizing", async () => {
		const listener = await openChannelListener({ dir: await scratch(), generation: 4 });
		const secret = await readSocketSecret(listener.env[TOOL_CHILD_SECRET_ENV]);
		const raw = createConnection(
			resolveSocketTransportAddress(listener.env[TOOL_CHILD_CHANNEL_ENV], process.platform, secret),
		);
		raw.on("error", () => {});
		await once(raw, "connect");
		sendSocketHandshake(raw, secret);
		const server = await listener.accepted;
		const frame = Buffer.alloc(4 + 3);
		frame.writeUInt32BE(3, 0);
		frame.write("{x}", 4);
		raw.write(frame);
		expect(await server.closed).toEqual({ kind: "codec", code: "tool_child_malformed" });
		raw.destroy();
		await listener.close();
	});

	it("delivers frames that arrive before the server subscribes", async () => {
		const listener = await openChannelListener({ dir: await scratch(), generation: 5 });
		const child = await connectChannel(listener.env);
		child.send({ type: "hello", generation: 5, pid: 1, protocol: 2, jobKinds: [] });
		child.send({ type: "pong", seq: 9 });
		const server = await listener.accepted;
		await new Promise((resolve) => setImmediate(resolve));
		const seen: ToolChildMessage[] = [];
		const both = new Promise<void>((resolve) =>
			server.onMessage((message) => {
				seen.push(message);
				if (seen.length === 2) resolve();
			}),
		);
		await both;
		expect(seen.map((message) => message.type)).toEqual(["hello", "pong"]);
		child.close();
		await listener.close();
	});

	it("reports whether the environment names a channel", () => {
		expect(channelEnvPresent({})).toBe(false);
		expect(channelEnvPresent({ [TOOL_CHILD_CHANNEL_ENV]: "/x" })).toBe(false);
		expect(channelEnvPresent({ [TOOL_CHILD_CHANNEL_ENV]: "/x", [TOOL_CHILD_SECRET_ENV]: "/y" })).toBe(true);
	});
});
