// senpi#3566 todo 4: every child_process launch API in a tool-child worker passes the execution barrier, with the
// per-API containment from DESIGN PART 1 (security contract). Real worker thread, real channel, real processes.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { connectChannel, openChannelListener } from "./channel.ts";
import { DescendantsLedger, LaunchLog } from "./descendants.ts";
import { defaultGroupProbes } from "./group-ownership.ts";
import { type BarrierViolation, LaunchEnforcer } from "./launch-enforcer.ts";
import { LaunchGate } from "./launch-gate.ts";
import type { WorkerLaunchMessage } from "./worker-launch.ts";

const workerFile = resolve(import.meta.dirname, "../../../../test/fixtures/gated-cp-worker.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function rig(options: { holdAcks?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "tgc-"));
	const listener = await openChannelListener({ dir: join(root, "ch"), generation: 1 });
	const childSide = await connectChannel(listener.env);
	const serverSide = await listener.accepted;
	await listener.close();
	const violations: BarrierViolation[] = [];
	const log = new LaunchLog(join(root, "launches.jsonl"));
	const releases: Array<() => void> = [];
	let heldWaiter: (() => void) | undefined;
	const enforcer = new LaunchEnforcer({
		generation: 1,
		ledger: new DescendantsLedger(join(root, "descendants.ledger")),
		log,
		sendAck: (launchId) => serverSide.send({ type: "launch_ack", launchId }),
		onViolation: (violation) => violations.push(violation),
		leaderStart: (pid) => defaultGroupProbes.startOf(pid),
		...(options.holdAcks
			? {
					holdAck: () =>
						new Promise<void>((release) => {
							releases.push(release);
							heldWaiter?.();
						}),
				}
			: {}),
	});
	serverSide.onMessage((message) => {
		if (message.type === "launch") void enforcer.onLaunch(message);
		if (message.type === "launch_proof") enforcer.onProof(message);
		if (message.type === "launch_done") enforcer.onDone(message);
	});
	const gate = new LaunchGate(childSide);
	childSide.onMessage((message) => {
		gate.handle(message);
	});
	const run = (scenario: "apis" | "sync-only") => {
		const worker = new Worker(workerFile, { workerData: { buffer: gate.clock.buffer, scenario } });
		const result = new Promise<Record<string, unknown>>((done, fail) => {
			worker.on("message", (message: WorkerLaunchMessage | { kind: "result"; value: Record<string, unknown> }) => {
				if (message.kind === "result") done(message.value);
				else gate.handleWorker(message);
			});
			worker.once("error", fail);
		});
		cleanups.push(() => worker.terminate().then(() => undefined));
		return result;
	};
	cleanups.push(async () => {
		childSide.close();
		serverSide.close();
		enforcer.dispose();
		await log.settled();
		await rm(root, { recursive: true, force: true });
	});
	const records = async () => {
		await log.settled();
		return (await readFile(log.path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	};
	const nextHeld = () => new Promise<void>((resolveHeld) => (heldWaiter = resolveHeld));
	return { gate, run, records, violations, releases, nextHeld };
}

describe.skipIf(process.platform === "win32")("gated child_process in a tool-child worker", () => {
	it("gates every API with its containment and an ordered proof", async () => {
		const { run, records, violations } = await rig();
		const result = await run("apis");
		expect(result).toMatchObject({ spawnSync: 3, ownedExit: 0, detachedExit: 0 });
		expect(result.ownedPgid).toBe(result.ownedPid);
		const launches = (await records()).filter((record) => record.type === "launch");
		expect(launches.map((launch) => [launch.api, launch.containment, launch.lifetime])).toEqual([
			["cp.spawnSync", "inherited", "owned"],
			["cp.spawn", "own-group", "owned"],
			["cp.spawn", "own-group", "detached"],
			["cp.execFileSync", "inherited", "owned"],
		]);
		const proofs = (await records()).filter((record) => record.type === "launch_proof");
		expect(proofs).toHaveLength(4);
		for (const proof of proofs) expect(Number(proof.ackTick)).toBeLessThan(Number(proof.invokeTick));
		expect(violations).toEqual([]);
	}, 60_000);

	it("blocks a synchronous launch until the ack: no invocation while held, exactly one after", async () => {
		const { gate, run, releases, nextHeld, violations } = await rig({ holdAcks: true });
		const held = nextHeld();
		const result = run("sync-only");
		await held;
		expect(gate.clock.read(0).invocations).toBe(0);
		releases[0]?.();
		expect(await result).toEqual({ spawnSync: 0 });
		expect(violations).toEqual([]);
	}, 60_000);
});
