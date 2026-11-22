/**
 * senpi#4602 (A-amended section 4, the senpi#2729 ordering rule carried into endpoint adoption): every rename or
 * remove of the shared public socket entry runs under one cross-process mutation fence keyed by the canonical
 * endpoint, and re-reads the endpoint's owner token inside it. A predecessor whose teardown was decided before a
 * successor adopted the name can therefore never remove or rename over the successor's entry afterwards.
 *
 * Real Unix sockets and the real SQLite fence; the only interleavings are the ones the hooks pause at, and every
 * wait subscribes before it triggers.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	adoptEndpoint,
	claimEndpoint,
	closeShieldedEndpoint,
	endpointOwnerToken,
	readEndpointOwner,
	settleCandidateAdoption,
	unlinkOwnedEndpoint,
} from "../../src/modes/rpc/host-endpoint-owner.ts";
import { startStartupController } from "../../src/modes/rpc/host-startup-policy.ts";
import { generationBindPath, type SocketFileIdentity } from "../../src/modes/rpc/socket-ownership.ts";
import { virtualClock } from "./host-startup-clock-support.ts";

const describePosix = process.platform === "win32" ? describe.skip : describe;

let dir: string;
const servers: Server[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "eo-"));
});

afterEach(async () => {
	for (const server of servers.splice(0)) server.close();
	await rm(dir, { recursive: true, force: true });
});

async function bound(path: string): Promise<SocketFileIdentity> {
	const server = createServer();
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	const { dev, ino } = await stat(path);
	return { dev, ino };
}

async function identityOf(path: string): Promise<SocketFileIdentity | undefined> {
	try {
		const { dev, ino } = await stat(path);
		return { dev, ino };
	} catch {
		return undefined;
	}
}

async function generations(): Promise<{
	socket: string;
	bind: string;
	predecessor: SocketFileIdentity;
	successor: SocketFileIdentity;
}> {
	const socket = join(dir, "p.sock");
	const bind = generationBindPath(socket, 1);
	const predecessor = await bound(socket);
	await claimEndpoint(socket, endpointOwnerToken(socket, "pred", 0));
	const successor = await bound(bind);
	return { socket, bind, predecessor, successor };
}

function adopt(socket: string, bind: string, predecessor: SocketFileIdentity, hooks?: { onFenceBusy?: () => void }) {
	return adoptEndpoint({
		bindSocket: bind,
		publicSocket: socket,
		expected: predecessor,
		expectedOwner: "pred",
		token: endpointOwnerToken(socket, "succ", 1),
		...(hooks ? { hooks } : {}),
	});
}

describePosix("endpoint owner token and mutation fence (senpi#4602 / #2729)", () => {
	it("adoption moves the public name to the successor and the owner token with it", async () => {
		const { socket, bind, predecessor, successor } = await generations();
		await adopt(socket, bind, predecessor);
		expect(await identityOf(socket)).toEqual(successor);
		expect((await readEndpointOwner(socket))?.instanceId).toBe("succ");
	});

	it("refuses to adopt an endpoint whose owner token names a generation other than the expected predecessor", async () => {
		const { socket, bind, predecessor, successor } = await generations();
		await claimEndpoint(socket, endpointOwnerToken(socket, "intruder", 7));
		await expect(adopt(socket, bind, predecessor)).rejects.toThrow(/owner/);
		expect(await identityOf(socket)).toEqual(predecessor);
		expect(await identityOf(bind)).toEqual(successor);
		expect((await readEndpointOwner(socket))?.instanceId).toBe("intruder");
	});

	it("a predecessor's late remove, decided before the adoption, leaves the successor's entry and token intact", async () => {
		const { socket, bind, predecessor, successor } = await generations();
		await adopt(socket, bind, predecessor);
		await unlinkOwnedEndpoint(socket, successor, "pred", () => {});
		expect(await identityOf(socket)).toEqual(successor);
		expect((await readEndpointOwner(socket))?.instanceId).toBe("succ");
	});

	it("a predecessor's shielded close after the adoption restores the successor's entry, never its own", async () => {
		const { socket, bind, predecessor, successor } = await generations();
		await adopt(socket, bind, predecessor);
		await closeShieldedEndpoint(socket, async () => {
			expect(await identityOf(socket)).toBeUndefined();
		});
		expect(await identityOf(socket)).toEqual(successor);
		expect((await readEndpointOwner(socket))?.instanceId).toBe("succ");
	});

	it("an adoption that arrives while the predecessor's validated remove holds the fence waits, then refuses the vanished entry", async () => {
		const { socket, bind, predecessor, successor } = await generations();
		const paused = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const order: string[] = [];
		const removal = unlinkOwnedEndpoint(socket, predecessor, "pred", () => {}, {
			afterValidate: async () => {
				paused.resolve();
				await resume.promise;
				order.push("predecessor removed");
			},
		});
		await paused.promise;
		const busy = Promise.withResolvers<void>();
		const adoption = adopt(socket, bind, predecessor, { onFenceBusy: () => busy.resolve() }).then(
			() => order.push("adopted"),
			(cause: unknown) => order.push(`refused: ${cause instanceof Error ? cause.message : String(cause)}`),
		);
		await busy.promise;
		resume.resolve();
		await removal;
		await adoption;
		expect(order[0]).toBe("predecessor removed");
		expect(order[1]).toMatch(/^refused: /);
		expect(await identityOf(socket)).toBeUndefined();
		expect(await identityOf(bind)).toEqual(successor);
	});

	it("an adoption rename that lands after its phase deadline is a completed handoff, not a rollback", async () => {
		const { socket, bind, predecessor } = await generations();
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "successor", clock });
		for (const phase of [
			"supervisor_bootstrap",
			"supervisor_setup",
			"host_bootstrap",
			"host_runtime",
			"internal_ready",
			"observer_ready",
			"presenter_resolved",
		] as const) {
			clock.advanceTo(1_000);
			expect(controller.complete(phase)).toBe("accepted");
		}
		expect(controller.phase).toBe("public_published");
		// The rename started inside P6 but commits 1 ms after its 15 s window: the controller has already expired.
		clock.advanceTo(1_000 + 15_000 + 1);
		expect(controller.terminal?.kind).toBe("timeout");
		await adopt(socket, bind, predecessor);
		let revoked = false;
		const outcome = await settleCandidateAdoption(socket, "succ", async () => {
			revoked = true;
		});
		expect(outcome).toBe("completed");
		expect(revoked).toBe(true);
	});

	it("a candidate that did not adopt before cleanup is fenced out: its revoked grant refuses a later adoption", async () => {
		const { socket, bind, predecessor, successor } = await generations();
		let granted = true;
		const outcome = await settleCandidateAdoption(socket, "succ", async () => {
			granted = false;
		});
		expect(outcome).toBe("not_adopted");
		await expect(
			adoptEndpoint({
				bindSocket: bind,
				publicSocket: socket,
				expected: predecessor,
				expectedOwner: "pred",
				token: endpointOwnerToken(socket, "succ", 1),
				granted: async () => granted,
			}),
		).rejects.toThrow(/grant/);
		expect(await identityOf(socket)).toEqual(predecessor);
		expect(await identityOf(bind)).toEqual(successor);
	});
});
