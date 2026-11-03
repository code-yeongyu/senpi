// senpi#3566 todo 4: the server enforces the execution barrier from the child's proof ticks (security contract).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DescendantsLedger, LaunchLog } from "./descendants.ts";
import { type BarrierViolation, LaunchEnforcer } from "./launch-enforcer.ts";
import type { ToolChildMessageOf } from "./protocol.ts";

const rigs: Array<{ root: string; log: LaunchLog }> = [];
afterEach(async () => {
	for (const { root, log } of rigs.splice(0)) {
		await log.settled();
		await rm(root, { recursive: true, force: true });
	}
});

const launch = (launchId: string): ToolChildMessageOf<"launch"> => ({
	type: "launch",
	launchId,
	jobId: "j1",
	origin: "tool",
	api: "bun.spawn",
	containment: "own-group",
	lifetime: "owned",
	pid: 4242,
	pgid: 4242,
});

async function rig(
	extra: {
		hold?: (id: string) => Promise<void>;
		onAck?: (id: string) => void;
		ledgerPath?: (root: string) => string;
		logPath?: (root: string) => string;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "tle-"));
	const acks: string[] = [];
	const violations: BarrierViolation[] = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const ledger = new DescendantsLedger(extra.ledgerPath?.(root) ?? join(root, "descendants.ledger"));
	const log = new LaunchLog(extra.logPath?.(root) ?? join(root, "launches.jsonl"));
	rigs.push({ root, log });
	const enforcer = new LaunchEnforcer({
		generation: 1,
		ledger,
		log,
		sendAck: (id) => {
			acks.push(id);
			extra.onAck?.(id);
		},
		onViolation: (violation) => violations.push(violation),
		leaderStart: async () => "Sat Oct 18 05:00:00 2026",
		...(extra.hold ? { holdAck: extra.hold } : {}),
		setTimer: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	});
	return { root, ledger, log, enforcer, acks, violations, timers };
}

describe("LaunchEnforcer", () => {
	it("never acks a launch whose ledger entry cannot be written, reports it as a violation, and never rejects", async () => {
		const blocked = await mkdtemp(join(tmpdir(), "tle-blocked-"));
		const notADir = join(blocked, "file");
		await writeFile(notADir, "");
		const { enforcer, acks, violations } = await rig({ ledgerPath: () => join(notADir, "descendants.ledger") });
		await expect(enforcer.onLaunch(launch("L1"))).resolves.toBeUndefined();
		expect(acks).toEqual([]);
		expect(violations).toEqual([
			{ launchId: "L1", jobId: "j1", reason: "ledger_unwritable", code: "tool_child_barrier_violation" },
		]);
		await rm(blocked, { recursive: true, force: true });
	});

	it("acks a recorded launch even when the diagnostic log cannot be written, and the log never rejects", async () => {
		const blocked = await mkdtemp(join(tmpdir(), "tle-blocked-"));
		const notADir = join(blocked, "file");
		await writeFile(notADir, "");
		const { enforcer, acks, violations, log } = await rig({ logPath: () => join(notADir, "launches.jsonl") });
		await enforcer.onLaunch(launch("L1"));
		expect(acks).toEqual(["L1"]);
		expect(violations).toEqual([]);
		await expect(log.settled()).resolves.toBeUndefined();
		expect(log.failedWrites).toBeGreaterThan(0);
		await rm(blocked, { recursive: true, force: true });
	});

	it("never reports proof_missing for a proof that arrived while the ack was being logged", async () => {
		let enforcerRef: LaunchEnforcer | undefined;
		const rigged = await rig({
			onAck: (id) => enforcerRef?.onProof({ type: "launch_proof", launchId: id, ackTick: 1, invokeTick: 2 }),
		});
		enforcerRef = rigged.enforcer;
		await rigged.enforcer.onLaunch(launch("L1"));
		for (const timer of rigged.timers) if (!timer.cancelled) timer.fn();
		expect(rigged.violations).toEqual([]);
	});

	it("persists the containment handle before acknowledging, and accepts an ordered proof", async () => {
		const { root, ledger, log: launchLog, enforcer, acks, violations, timers } = await rig();
		await enforcer.onLaunch(launch("l1"));
		const persisted = await DescendantsLedger.readPersisted(ledger.path);
		expect(persisted).toEqual([
			expect.objectContaining({
				launchId: "l1",
				pgid: 4242,
				lifetime: "owned",
				leaderStart: "Sat Oct 18 05:00:00 2026",
			}),
		]);
		expect(acks).toEqual(["l1"]);
		enforcer.onProof({ type: "launch_proof", launchId: "l1", ackTick: 3, invokeTick: 4 });
		expect(timers[0]?.cancelled).toBe(true);
		expect(violations).toEqual([]);
		await launchLog.settled();
		const log = (await readFile(join(root, "launches.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).type);
		expect(log).toEqual(["launch", "launch_ack", "launch_proof"]);
	});

	it.each([
		["a null ackTick", { ackTick: null, invokeTick: 4 }, "proof_unacked"],
		["an invocation before the ack", { ackTick: 5, invokeTick: 4 }, "proof_unordered"],
		["equal ticks", { ackTick: 4, invokeTick: 4 }, "proof_unordered"],
	])("raises a violation for %s", async (_label, ticks, reason) => {
		const { enforcer, violations } = await rig();
		await enforcer.onLaunch(launch("l1"));
		enforcer.onProof({ type: "launch_proof", launchId: "l1", ...ticks });
		expect(violations).toEqual([{ launchId: "l1", jobId: "j1", reason, code: "tool_child_barrier_violation" }]);
	});

	it("raises proof_missing when the proof deadline passes after the ack", async () => {
		const { enforcer, violations, timers } = await rig();
		await enforcer.onLaunch(launch("l1"));
		expect(timers.map((timer) => timer.ms)).toEqual([5_000]);
		timers[0]?.fn();
		expect(violations).toEqual([
			{ launchId: "l1", jobId: "j1", reason: "proof_missing", code: "tool_child_barrier_violation" },
		]);
	});

	it("detects an invocation while the ack is still held, without ever acknowledging", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { enforcer, acks, violations } = await rig({ hold: () => held });
		const pending = enforcer.onLaunch(launch("l1"));
		await new Promise((resolve) => setImmediate(resolve));
		enforcer.onProof({ type: "launch_proof", launchId: "l1", ackTick: null, invokeTick: 2 });
		expect(violations).toEqual([
			{ launchId: "l1", jobId: "j1", reason: "proof_unacked", code: "tool_child_barrier_violation" },
		]);
		release();
		await pending;
		expect(acks).toEqual([]);
	});

	it("treats a proof for an unknown launch as a violation, and reports only the first violation", async () => {
		const { enforcer, violations } = await rig();
		enforcer.onProof({ type: "launch_proof", launchId: "ghost", ackTick: 1, invokeTick: 2 });
		enforcer.onProof({ type: "launch_proof", launchId: "ghost2", ackTick: 1, invokeTick: 2 });
		expect(violations).toEqual([
			{ launchId: "ghost", jobId: undefined, reason: "proof_unknown_launch", code: "tool_child_barrier_violation" },
		]);
	});

	it("sets no deadline on launch_done", async () => {
		const { enforcer, timers, violations } = await rig();
		await enforcer.onLaunch(launch("l1"));
		enforcer.onProof({ type: "launch_proof", launchId: "l1", ackTick: 1, invokeTick: 2 });
		enforcer.onDone({ type: "launch_done", launchId: "l1", exitCode: 0 });
		expect(timers.filter((timer) => !timer.cancelled)).toEqual([]);
		expect(violations).toEqual([]);
	});
});
