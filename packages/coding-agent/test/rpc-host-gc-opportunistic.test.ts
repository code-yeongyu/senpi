/**
 * The budgeted gc pass `ensureHost` schedules once it has returned a host: dead endpoint records under
 * the agent directory are reaped on `host gc`'s own three-part evidence without an operator command,
 * the ensure itself resolves before the pass removes anything, and the target endpoint is never judged.
 */
import { existsSync, readdirSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { acquireHostEnsureLock } from "../src/modes/rpc/host-ensure-lock.ts";
import { readProcessStartTime } from "../src/utils/process-identity.ts";
import { endpointScratch, heldRealHost, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";
import { closeServer, deadEndpoint, listeningSocket, writeJson } from "./helpers/rpc-host-gc-fixtures.ts";
import { fileWritten, gcMarkerPath, readGcMarker } from "./helpers/rpc-host-gc-pass-fixtures.ts";
import { probeSandboxHost } from "./helpers/rpc-sandbox-host.ts";

afterEach(sweepEndpointScratches, 180_000);

describe.skipIf(process.platform === "win32")("budgeted gc pass scheduled by ensure", () => {
	it("returns the host before removing anything, then reaps at most 32 dead records and leaves live and target alone", async () => {
		const qa = endpointScratch("ogc");
		const deadDirs: string[] = [];
		for (let index = 0; index < 40; index += 1) {
			deadDirs.push((await deadEndpoint(join(qa.root, "d", `e${index}.sock`), qa.agentDir)).dir);
		}
		const live = await deadEndpoint(join(qa.root, "d", "live.sock"), qa.agentDir);
		const startTime = await readProcessStartTime(process.pid);
		await writeJson(generationPaths(live, "g-live").pidFile, { pid: process.pid, processStartTime: startTime });
		const target = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });

		let presentAtResolution = -1;
		const host = await heldRealHost(qa, qa.legacy, { gcPassInFlight: true }).then((ensured) => {
			// Synchronous on purpose: no event-loop turn may run between the settle and this count.
			presentAtResolution = deadDirs.filter((dir) => existsSync(dir)).length;
			return ensured;
		});
		host.release();
		expect(presentAtResolution).toBe(40);

		await fileWritten(gcMarkerPath(qa.agentDir), 10_000);
		const marker = await readGcMarker(qa.agentDir);
		const remaining = deadDirs.filter((dir) => existsSync(dir)).length;
		const removed = 40 - remaining;
		expect(removed).toBeGreaterThan(0);
		expect(removed).toBeLessThanOrEqual(32);
		expect(marker.removed).toBe(removed);
		// The live endpoint competes for the 32 slots too, so the count cap bounds what was examined.
		expect(marker.examined).toBeLessThanOrEqual(32);
		if (marker.stoppedBy === "count") expect(marker.examined).toBe(32);
		expect(existsSync(live.endpointFile)).toBe(true);
		expect(existsSync(target.endpointFile)).toBe(true);
		expect(readdirSync(target.generationsDir)).not.toHaveLength(0);
		expect(await probeSandboxHost(qa, { socket: qa.legacy })).toBeDefined();
	}, 180_000);

	it("returns the host before the GC pass completes with 40 locked candidates", async () => {
		const qa = endpointScratch("ogl");
		const marker = gcMarkerPath(qa.agentDir);
		// Each candidate costs a gc the full 2 s lock wait: its ensure lock is held here.
		const held: (() => Promise<void>)[] = [];
		const servers: Server[] = [];
		try {
			for (let index = 0; index < 40; index += 1) {
				const socket = join(qa.root, "c", `c${index}.sock`);
				await deadEndpoint(socket, qa.agentDir);
				held.push(await acquireHostEnsureLock(socket, 2_000));
				servers.push(await listeningSocket(socket));
			}
			const host = await heldRealHost(qa, qa.legacy, { gcPassInFlight: true });
			expect(existsSync(marker)).toBe(false);
			host.release();
			await fileWritten(marker, 30_000);
			const gcMarker = await readGcMarker(qa.agentDir);
			expect(gcMarker.removed).toBe(0);
			expect(gcMarker.examined).toBeGreaterThan(0);
		} finally {
			for (const release of held) await release();
			for (const server of servers) await closeServer(server);
		}
	}, 180_000);
});
