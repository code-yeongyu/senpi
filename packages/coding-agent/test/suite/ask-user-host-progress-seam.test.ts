import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";

type LineSink = { lines: string[]; nextLine(): Promise<string> };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(socketPath: string): Promise<{ server: Server; sink: LineSink }> {
	const lines: string[] = [];
	const waiters: Array<(line: string) => void> = [];
	let buffer = "";
	const server = createServer((socket: Socket) => {
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				const waiter = waiters.shift();
				if (waiter) waiter(line);
				else lines.push(line);
				index = buffer.indexOf("\n");
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const nextLine = () => {
		const queued = lines.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no line written within 5s")), 5_000);
			waiters.push((line) => {
				clearTimeout(timer);
				resolve(line);
			});
		});
	};
	return { server, sink: { lines, nextLine } };
}

async function connectedClient(): Promise<{ client: RpcClient; sink: LineSink; cwd: string }> {
	const cwd = mkdtempSync(join(tmpdir(), "ask-user-seam-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const socketPath = join(cwd, "host.sock");
	const { sink } = await listen(socketPath);
	const client = new RpcClient({ socketPath });
	await client.start();
	cleanups.push(() => client.stop());
	return { client, sink, cwd };
}

describe("RpcClient question progress seam", () => {
	it("RpcClient writes extension_ui_progress with the request id intact and no reply wait", async () => {
		const { client, sink } = await connectedClient();
		await client.sendExtensionUIProgress({
			type: "extension_ui_progress",
			id: "ui-1",
			answers: { auth: { selected: ["OAuth"] } },
			comment: "par",
		});
		expect(JSON.parse(await sink.nextLine())).toEqual({
			type: "extension_ui_progress",
			id: "ui-1",
			answers: { auth: { selected: ["OAuth"] } },
			comment: "par",
		});
	});
});
