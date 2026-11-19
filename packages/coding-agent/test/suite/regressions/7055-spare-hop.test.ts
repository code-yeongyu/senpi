import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectAuthenticatedRpcSocket } from "../../../src/modes/rpc/rpc-auth-client.ts";
import {
	authenticatedClient,
	openSpare,
	type Step,
	type SteppedSupervisor,
	steppedSupervisor,
} from "./7055-stepped-engine-support.ts";

const disposers: (() => Promise<void>)[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const dispose of disposers.splice(0)) await dispose();
});

async function supervisor(options?: Parameters<typeof steppedSupervisor>[0]): Promise<SteppedSupervisor> {
	const s = await steppedSupervisor(options);
	disposers.push(() => s.dispose());
	return s;
}

async function client(s: SteppedSupervisor) {
	const connected = await authenticatedClient(s);
	sockets.push(connected.socket);
	return connected;
}

const accepts = (turns: readonly Step[]) => turns.filter((turn) => turn.kind === "accept");

describe.skipIf(process.platform === "win32")("senpi#7055 supervisor spare engine hop", () => {
	it("answers a client's challenge after one engine turn once a spare hop is ready, never an engine accept", async () => {
		const s = await supervisor();
		const first = await client(s);
		expect(accepts(first.turns)).toEqual([{ kind: "accept", conn: 1 }]);
		await openSpare(s, 2);
		const second = await client(s);
		expect(accepts(second.turns)).toEqual([]);
		expect(second.turns.filter((turn) => turn.conn === 2)).toEqual([
			{ kind: "record", conn: 2, type: "get_protocol_info", id: "rpc-auth-protocol" },
		]);
		expect(second.data.connection).toBe(2);
		expect(s.timers.pending()).toEqual([0]);
	});

	it("keeps per-connection state per client and never hands a hop to a second client", async () => {
		const s = await supervisor();
		const a = await client(s);
		await openSpare(s, 2);
		const b = await client(s);
		await a.ask({ id: "caps-a", type: "set_caps", caps: ["a"] });
		await b.ask({ id: "caps-b", type: "set_caps", caps: ["b"] });
		expect(await a.ask({ id: "info-a", type: "get_protocol_info" })).toMatchObject({
			data: { capabilities: ["a"], connection: 1 },
		});
		expect(await b.ask({ id: "info-b", type: "get_protocol_info" })).toMatchObject({
			data: { capabilities: ["b"], connection: 2 },
		});
		a.socket.destroy();
		b.socket.destroy();
		await s.engine.whenClosed(1);
		await s.engine.whenClosed(2);
		await openSpare(s, 3);
		const c = await client(s);
		expect(c.data.connection).toBe(3);
		expect(c.data.capabilities).not.toContain("b");
	});

	it("holds no occupancy for an idle spare, on the engine or the supervisor, and keeps exactly one", async () => {
		const s = await supervisor();
		const a = await client(s);
		a.socket.destroy();
		await s.engine.whenClosed(1);
		await openSpare(s, 2);
		expect(s.timers.pending()).toEqual([]);
		expect(s.engine.history.filter((turn) => turn.kind === "accept")).toHaveLength(2);
		expect([s.engine.occupancy.attachedCount, s.engine.occupancy.unclassifiedCount]).toEqual([0, 0]);
		expect([s.clients.attachedCount, s.clients.unclassifiedCount]).toEqual([0, 0]);
	});

	it("backs off a failing refill and gives up after a bounded number of attempts; the engine refuses a wrong hop key", async () => {
		const s = await supervisor({ engineKey: Buffer.alloc(32, 1) });
		const doomed = connectAuthenticatedRpcSocket(s.publicPath, undefined, { keyRoot: s.agentDir }, 60_000);
		doomed.catch(() => {});
		await s.engine.step();
		await s.engine.whenClosed(1);
		const delays: number[] = [];
		for (let conn = 2; s.timers.pending().length > 0; conn++) {
			const [delay] = s.timers.pending();
			delays.push(delay);
			s.timers.fire(delay);
			expect(await s.engine.step()).toEqual({ kind: "accept", conn });
			await s.engine.whenClosed(conn);
		}
		expect(delays).toEqual([0, 250, 500, 1000, 2000]);
		expect(s.engine.refusedHops).toHaveLength(6);
		await expect(doomed).rejects.toThrow();
	});
});
