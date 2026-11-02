import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostDaemonDirectoryPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { createSessionPathReservations, readSessionPathClaims } from "../../../src/modes/rpc/host-reservations.ts";
import { reservationHost, reservationPhase } from "../rpc-worker-reservation-support.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function workerHost() {
	const root = await mkdtemp(join(tmpdir(), "held-worker-claims-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const first = join(root, "first.jsonl");
	const second = join(root, "second.jsonl");
	for (const file of [first, second])
		await writeFile(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd, timestamp: new Date(0).toISOString() })}\n`,
		);
	const daemon = createSessionPathReservations({ daemonDir: join(root, "daemon"), instanceId: "current" });
	vi.stubEnv("SENPI_OFFLINE", "1");
	const host = reservationHost(cwd, agentDir, undefined, { pathReservations: daemon });
	host.connect("client");
	try {
		await host.send("client", {
			id: "open",
			type: "open_session",
			cwd,
			sessionPath: first,
			retain_on_disconnect: true,
		});
		await host.writer.flush();
		expect(host.records).toContainEqual(expect.objectContaining({ type: "response", id: "open", success: true }));
		const handle = host.registry.list()[0]?.sessionId;
		if (!handle) throw new Error("Worker did not open");
		return {
			root,
			first: await realpath(first),
			second: await realpath(second),
			daemon,
			host,
			handle,
			claimDir: hostDaemonDirectoryPaths(join(root, "daemon")).reservationsDir,
		};
	} catch (cause) {
		await host.dispose();
		await rm(root, { recursive: true, force: true });
		throw cause;
	}
}

// senpi#2951: real worker switches must move the cross-generation ownership evidence.
it("moves a real worker's daemon claim to its switched session file", async () => {
	const rig = await workerHost();
	try {
		const claim = vi.spyOn(rig.daemon, "claim");
		const removed = Promise.withResolvers<void>();
		const originalRelease = rig.daemon.release.bind(rig.daemon);
		const release = vi.spyOn(rig.daemon, "release").mockImplementation(async (path) => {
			await originalRelease(path);
			if (path === rig.first) removed.resolve();
		});
		await rig.host.send("client", {
			id: "switch",
			type: "switch_session",
			sessionId: rig.handle,
			sessionPath: rig.second,
		});
		await rig.host.writer.flush();
		expect(rig.host.records).toContainEqual(
			expect.objectContaining({ type: "response", id: "switch", success: true }),
		);
		expect(claim).toHaveBeenCalledWith(rig.second, true);
		expect(release).toHaveBeenCalledWith(rig.first);
		expect(rig.host.registry.peek(rig.handle)?.reservationKey).toBe(rig.second);
		await reservationPhase("old-claim-removed", removed.promise);
		expect((await readSessionPathClaims(rig.claimDir)).map(({ owner }) => owner.sessionPath)).toEqual([rig.second]);
	} finally {
		await rig.host.dispose();
		await rm(rig.root, { recursive: true, force: true });
	}
});

it("publishes a real retained idle worker's detached claim state", async () => {
	const rig = await workerHost();
	try {
		const detached = Promise.withResolvers<void>();
		const originalAttached = rig.daemon.setAttached.bind(rig.daemon);
		const attached = vi.spyOn(rig.daemon, "setAttached").mockImplementation((path, value) => {
			originalAttached(path, value);
			if (path === rig.first && !value) detached.resolve();
		});
		await rig.host.disconnect("client");
		expect(rig.host.registry.peek(rig.handle)).toMatchObject({
			state: "open",
			attachments: 0,
			detachedAt: expect.any(Number),
		});
		await reservationPhase("idle-claim-detached", detached.promise);
		expect(attached).toHaveBeenCalledWith(rig.first, false);
	} finally {
		await rig.host.dispose();
		await rm(rig.root, { recursive: true, force: true });
	}
});

it("bounds real native-exit cleanup when daemon claim removal does not settle", async () => {
	const rig = await workerHost();
	const unblock = Promise.withResolvers<void>();
	try {
		const worker = [...rig.host.workers][0];
		if (!worker) throw new Error("Real worker is absent");
		const started = Promise.withResolvers<void>();
		const originalRelease = rig.daemon.release.bind(rig.daemon);
		vi.spyOn(rig.daemon, "release").mockImplementation(async (path) => {
			started.resolve();
			await originalRelease(path);
			await unblock.promise;
		});
		let settled = false;
		const completion = worker.exited.then(() => {
			settled = true;
		});
		const nativeExit = once(worker.worker, "exit");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		worker.quarantine();
		await nativeExit;
		await reservationPhase("claim-removal-started", started.promise);
		await vi.advanceTimersByTimeAsync(rig.host.registry.closeGraceMs);
		expect(settled).toBe(true);
		expect(rig.host.registry.peek(rig.handle)).toBeUndefined();
		await completion;
	} finally {
		unblock.resolve();
		vi.useRealTimers();
		await rig.host.dispose();
		await rm(rig.root, { recursive: true, force: true });
	}
});
