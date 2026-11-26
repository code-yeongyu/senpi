// senpi#3566 todo 4: no command a tool child launches runs before the server recorded its containment (security
// contract). The child gate and the server enforcer talk over a real channel; commands are real processes.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectChannel, openChannelListener } from "./channel.ts";
import { DescendantsLedger, LaunchLog } from "./descendants.ts";
import { defaultGroupProbes, sweepGroups } from "./group-ownership.ts";
import { gateInherited, launchOwnGroup } from "./launch-barrier.ts";
import { type BarrierViolation, LaunchEnforcer } from "./launch-enforcer.ts";
import { LaunchGate } from "./launch-gate.ts";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function rig(gateEnv: NodeJS.ProcessEnv = {}) {
	const root = await mkdtemp(join(tmpdir(), "tlb-"));
	roots.push(root);
	const listener = await openChannelListener({ dir: join(root, "ch"), generation: 1 });
	const childSide = await connectChannel(listener.env);
	const serverSide = await listener.accepted;
	await listener.close();
	const holds = new Map<string, () => void>();
	const held = new Set<string>();
	const heldWaiters: Array<{ count: number; resolve: () => void }> = [];
	const doneSeen = new Map<string, () => void>();
	const waitDone = (launchId: string) => new Promise<void>((resolve) => doneSeen.set(launchId, resolve));
	const violations: BarrierViolation[] = [];
	let violationSeen: ((violation: BarrierViolation) => void) | undefined;
	const firstViolation = new Promise<BarrierViolation>((resolve) => {
		violationSeen = resolve;
	});
	const ledger = new DescendantsLedger(join(root, "descendants.ledger"));
	const log = new LaunchLog(join(root, "launches.jsonl"));
	const enforcer = new LaunchEnforcer({
		generation: 1,
		ledger,
		log,
		sendAck: (launchId) => serverSide.send({ type: "launch_ack", launchId }),
		onViolation: (violation) => {
			violations.push(violation);
			violationSeen?.(violation);
		},
		leaderStart: (pid) => defaultGroupProbes.startOf(pid),
		holdAck: (launchId) =>
			new Promise<void>((resolve) => {
				held.add(launchId);
				holds.set(launchId, resolve);
				for (const waiter of heldWaiters.filter((w) => held.size >= w.count)) waiter.resolve();
			}),
	});
	serverSide.onMessage((message) => {
		if (message.type === "launch") {
			void enforcer.onLaunch(message);
		}
		if (message.type === "launch_proof") enforcer.onProof(message);
		if (message.type === "launch_done") {
			enforcer.onDone(message);
			doneSeen.get(message.launchId)?.();
		}
	});
	const gate = new LaunchGate(childSide, undefined, gateEnv);
	childSide.onMessage((message) => {
		gate.handle(message);
	});
	cleanups.push(async () => {
		childSide.close();
		serverSide.close();
		enforcer.dispose();
		await log.settled();
	});
	const waitHeld = (count: number) =>
		new Promise<void>((resolve) => {
			if (held.size >= count) resolve();
			else heldWaiters.push({ count, resolve });
		});
	const release = (launchId: string) => holds.get(launchId)?.();
	const proofs: string[] = [];
	const proofWaiters = new Map<string, () => void>();
	const proofSeen = (launchId: string) => new Promise<void>((resolve) => proofWaiters.set(launchId, resolve));
	serverSide.onMessage((message) => {
		if (message.type !== "launch_proof") return;
		proofs.push(message.launchId);
		proofWaiters.get(message.launchId)?.();
	});
	return { root, gate, ledger, log, violations, firstViolation, waitHeld, waitDone, release, held, proofs, proofSeen };
}

describe.skipIf(process.platform === "win32")("POSIX launch barrier", () => {
	it("holds an own-group command until the ack, then runs it once with an ordered proof", async () => {
		const { root, gate, ledger, log, violations, waitHeld, waitDone, release, held } = await rig();
		const marker = join(root, "ran");
		const launching = launchOwnGroup({
			gate,
			jobId: "j1",
			origin: "tool",
			api: "bun.spawn",
			program: "/bin/sh",
			args: ["-c", `touch '${marker}'`],
		});
		await waitHeld(1);
		const [launchId] = [...held];
		if (launchId === undefined) throw new Error("no launch");
		expect(gate.clock.read(0).invocations).toBe(0);
		const [entry] = await DescendantsLedger.readPersisted(ledger.path);
		expect(entry).toMatchObject({ launchId, containment: "own-group", lifetime: "owned" });
		expect(entry?.pgid).toBe(entry?.pid);
		const done = waitDone(launchId);
		release(launchId);
		const { exited } = await launching;
		expect((await exited).exitCode).toBe(0);
		expect(existsSync(marker)).toBe(true);
		await done;
		await log.settled();
		const records = (await readFile(log.path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const proof = records.find((record) => record.type === "launch_proof");
		expect(proof.ackTick).toBeLessThan(proof.invokeTick);
		expect(records.findIndex((record) => record.type === "launch_proof")).toBeLessThan(
			records.findIndex((record) => record.type === "launch_done"),
		);
		expect(violations).toEqual([]);
	}, 30_000);

	it("keeps pid and group across exec env -i, so the ledgered group can be swept", async () => {
		const { gate, ledger, waitHeld, release, held } = await rig();
		const launching = launchOwnGroup({
			gate,
			jobId: "j1",
			origin: "tool",
			api: "cp.spawn",
			program: "/bin/sh",
			args: ["-c", "exec env -i /bin/sleep 300"],
		});
		await waitHeld(1);
		release([...held][0] ?? "");
		const { child } = await launching;
		const [entry] = await DescendantsLedger.readPersisted(ledger.path);
		expect(entry?.pid).toBe(child.pid);
		const [outcome] = await sweepGroups(
			[
				{
					launchId: entry?.launchId ?? "",
					pgid: entry?.pgid ?? -1,
					leaderStart: entry?.leaderStart,
					lifetime: "owned",
				},
			],
			{ graceMs: 3_000, killWaitMs: 3_000 },
		);
		expect(outcome).toMatchObject({ verdict: "sweep", survived: false });
	}, 30_000);

	it("detects SKIP_ACK_WAIT: the call runs while the ack is held and its proof carries no ackTick", async () => {
		const { gate, waitHeld, held, firstViolation } = await rig({ SENPI_TOOL_CHILD_TEST_SKIP_ACK_WAIT: "1" });
		let calls = 0;
		const gated = await gateInherited(gate, { jobId: "j1", origin: "tool", api: "cp.execFileSync" }, () => ++calls);
		await waitHeld(1);
		expect(gated.value).toBe(1);
		const violation = await firstViolation;
		expect(violation).toMatchObject({ launchId: [...held][0], reason: "proof_unacked" });
	}, 30_000);

	it("holds a detached launch's proof until its control file, and never an owned one's", async () => {
		const root = await mkdtemp(join(tmpdir(), "tlb-ctl-"));
		roots.push(root);
		const env = { SENPI_TOOL_CHILD_TEST_HOLD_LAUNCH_PROOF: "detached", SENPI_TOOL_CHILD_TEST_CONTROL_DIR: root };
		const { gate, waitHeld, release, held, proofs, proofSeen, waitDone } = await rig(env);
		const launching = launchOwnGroup({
			gate,
			jobId: "j1",
			origin: "tool",
			api: "cp.spawn",
			program: "/bin/sh",
			args: ["-c", "exit 0"],
			lifetime: "detached",
		});
		await waitHeld(1);
		const launchId = [...held][0] ?? "";
		const done = waitDone(launchId);
		release(launchId);
		await (await launching).exited;
		await done;
		expect(proofs).toEqual([]);
		const proven = proofSeen(launchId);
		await writeFile(join(root, `release-proof-${launchId}`), "");
		await proven;
	}, 30_000);

	it("gates an inherited call: no invocation while held, exactly one after", async () => {
		const { gate, waitHeld, release, held, violations } = await rig();
		let calls = 0;
		const gated = gateInherited(gate, { jobId: "j1", origin: "tool", api: "cp.execFileSync" }, () => ++calls);
		await waitHeld(1);
		expect(calls).toBe(0);
		expect(gate.clock.read(0).invocations).toBe(0);
		release([...held][0] ?? "");
		expect((await gated).value).toBe(1);
		expect(gate.clock.read(0).invocations).toBe(1);
		expect(violations).toEqual([]);
	}, 30_000);
});
