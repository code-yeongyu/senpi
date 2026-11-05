/**
 * senpi#5761: RpcClient writes `extension_ui_response` and `extension_ui_progress` without waiting for a reply. The
 * engine answers both, so those replies arrive with no pending request; they are this client's own unawaited sends
 * and are consumed quietly, never reported as a dropped response or handed to event listeners. A reply nobody sent
 * for is still reported.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { answerProtocolInfo } from "../helpers/rpc-legacy-protocol.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A host that answers every record it gets with one `response` line keyed by the record's id, then a marker event. */
async function replyingHost(socketPath: string): Promise<{ push: (record: object) => void }> {
	const peers: Socket[] = [];
	const server = createServer((socket) => {
		peers.push(socket);
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
				const record = JSON.parse(buffer.slice(0, index)) as { id?: string; type?: string };
				buffer = buffer.slice(index + 1);
				if (answerProtocolInfo(socket, record)) continue;
				socket.write(
					`${JSON.stringify({ id: record.id, type: "response", command: record.type, success: true })}\n`,
				);
				socket.write(`${JSON.stringify({ type: "marker", after: record.type })}\n`);
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { push: (record) => peers.at(-1)?.write(`${JSON.stringify(record)}\n`) };
}

async function client() {
	const cwd = mkdtempSync(join(tmpdir(), "unawaited-replies-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const socketPath = join(cwd, "host.sock");
	const host = await replyingHost(socketPath);
	const rpc = new RpcClient({ socketPath });
	await rpc.start();
	cleanups.push(() => rpc.stop());
	const events: Array<{ type?: string; after?: string }> = [];
	rpc.onEvent((event) => events.push(event as { type?: string; after?: string }));
	const markerAfter = (type: string) =>
		vi.waitUntil(() => events.some((e) => e.type === "marker" && e.after === type));
	return { rpc, host, events, markerAfter };
}

it("consumes the engine's replies to its own unawaited progress and response sends quietly", async () => {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const c = await client();
	await c.rpc.sendExtensionUIProgress({ type: "extension_ui_progress", id: "ui-1", answers: {} });
	await c.markerAfter("extension_ui_progress");
	await c.rpc.sendExtensionUIResponse({ type: "extension_ui_response", id: "ui-1", cancelled: true });
	await c.markerAfter("extension_ui_response");
	const dropped = stderr.mock.calls.filter(([chunk]) => String(chunk).includes("dropped response"));
	expect(dropped).toEqual([]);
	expect(c.events.filter((e) => e.type === "response")).toEqual([]);
});

it("still reports a reply that answers nothing this client sent", async () => {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const c = await client();
	c.host.push({ id: "never-sent", type: "response", command: "get_state", success: true });
	c.host.push({ type: "marker", after: "stray" });
	await c.markerAfter("stray");
	const dropped = stderr.mock.calls.filter(([chunk]) => String(chunk).includes("dropped response"));
	expect(dropped).toHaveLength(1);
});
