/**
 * senpi#3956: the rpc monitor's observer must never count as an ATTACHED client of the host it watches.
 * The supervisor idle-exits only with zero attached clients (`host-client-occupancy.ts`), and a
 * `children`/`all` watch connects to every endpoint, so one attaching observer pins every task shard
 * host on the machine. The real observer talks to a socket whose server classifies it with the
 * supervisor's own `ClientOccupancy`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRpcObserver } from "../../../src/core/extensions/builtin/terminal/rpc-monitor-observer.ts";
import { parseRpcTarget, subscriptionFor } from "../../../src/core/extensions/builtin/terminal/rpc-monitor-targets.ts";
import { ClientOccupancy } from "../../../src/modes/rpc/host-client-occupancy.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A host-shaped endpoint: classifies every client like the supervisor, then answers the subscribe. */
async function classifyingEndpoint() {
	const dir = mkdtempSync(join(tmpdir(), "senpi-3956-"));
	const socketPath = join(dir, "host.sock");
	const occupancy = new ClientOccupancy(() => undefined);
	const firstLines: string[] = [];
	const server: Server = createServer((client: Socket) => {
		occupancy.admit(client);
		let pending = "";
		client.on("data", (chunk) => {
			pending += chunk.toString("utf8");
			for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				firstLines.push(line);
				const request = JSON.parse(line) as { id?: string };
				client.write(
					`${JSON.stringify({ type: "response", id: request.id, success: true, data: { snapshot: [] } })}\n`,
				);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanups.push(() => {
		occupancy.destroyAll();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { socketPath, occupancy, firstLines };
}

describe("rpc monitor observer occupancy (senpi#3956)", () => {
	for (const text of ["children", "all", "parent-3956"]) {
		it(`a ${text} watch subscribes as an observer, never as an attached client`, async () => {
			const { socketPath, occupancy, firstLines } = await classifyingEndpoint();
			const target = parseRpcTarget(text, "parent-3956");
			if ("error" in target) throw new Error(target.error);
			const closed: string[] = [];

			const observer = await openRpcObserver(socketPath, subscriptionFor(target, ["session_status"]), {
				record: () => undefined,
				closed: (reason) => closed.push(reason),
			});
			cleanups.push(() => observer.close());
			await observer.subscribed;

			// The public endpoint challenge comes first (senpi#3795), itself an observing read; this endpoint answers
			// without `data.auth`, like a host that predates authentication, so no `authenticate` follows.
			expect(firstLines.map((line) => JSON.parse(line))).toMatchObject([
				{ type: "get_protocol_info", observe: true },
				{ type: "subscribe_sessions" },
			]);
			expect(occupancy.attachedCount).toBe(0);
			expect(occupancy.unclassifiedCount).toBe(0);
			expect(closed).toEqual([]);
		});
	}
});
