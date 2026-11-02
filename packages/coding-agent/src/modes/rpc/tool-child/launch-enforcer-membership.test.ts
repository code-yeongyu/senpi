// senpi#3566 todo 4 (Windows half): creation-time job membership from `command_started`, and a `breakaway` that
// contradicts the ledgered containment ends the generation as a containment violation (security contract).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DescendantsLedger, LaunchLog } from "./descendants.ts";
import { type BarrierViolation, LaunchEnforcer } from "./launch-enforcer.ts";
import type { LaunchContainment, ToolChildMessageOf } from "./protocol.ts";

const roots: Array<{ root: string; log: LaunchLog }> = [];
afterEach(async () => {
	for (const { root, log } of roots.splice(0)) {
		await log.settled();
		await rm(root, { recursive: true, force: true });
	}
});

async function rig(confirmMember?: (pid: number) => boolean) {
	const root = await mkdtemp(join(tmpdir(), "tlm-"));
	const log = new LaunchLog(join(root, "launches.jsonl"));
	roots.push({ root, log });
	const violations: BarrierViolation[] = [];
	const enforcer = new LaunchEnforcer({
		generation: 1,
		ledger: new DescendantsLedger(join(root, "descendants.ledger")),
		log,
		sendAck: () => {},
		onViolation: (violation) => violations.push(violation),
		leaderStart: async () => undefined,
		setTimer: () => () => {},
		...(confirmMember === undefined ? {} : { confirmMember }),
	});
	const records = async () => {
		await log.settled();
		return (await readFile(log.path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	};
	return { enforcer, violations, records };
}

const launch = (launchId: string, containment: LaunchContainment): ToolChildMessageOf<"launch"> => ({
	type: "launch",
	launchId,
	jobId: "j1",
	origin: "kernel",
	api: "cp.spawn",
	containment,
	lifetime: containment === "breakaway" ? "detached" : "owned",
});

const started = (
	launchId: string,
	fields: { creatorInJob: boolean; breakaway: boolean },
): ToolChildMessageOf<"command_started"> => ({
	type: "command_started",
	launchId,
	pid: 7000,
	startedAtMs: 1,
	...fields,
});

describe("LaunchEnforcer and command_started", () => {
	it("records creation-time membership for a job launch and non-membership for a breakaway one", async () => {
		const { enforcer, violations, records } = await rig();
		await enforcer.onLaunch(launch("in-job", "job"));
		await enforcer.onLaunch(launch("away", "breakaway"));
		enforcer.onCommandStarted(started("in-job", { creatorInJob: true, breakaway: false }));
		enforcer.onCommandStarted(started("away", { creatorInJob: true, breakaway: true }));
		const memberships = (await records()).filter((record) => record.type === "job_membership");
		expect(memberships).toEqual([
			expect.objectContaining({ launchId: "in-job", member: true, evidence: "creation" }),
			expect.objectContaining({ launchId: "away", member: false, evidence: "creation" }),
		]);
		expect(violations).toEqual([]);
	});

	it("adds a live listing as confirmation for a member, and records a missing listing without refuting it", async () => {
		for (const listed of [true, false]) {
			const { enforcer, violations, records } = await rig(() => listed);
			await enforcer.onLaunch(launch("l", "job"));
			enforcer.onCommandStarted(started("l", { creatorInJob: true, breakaway: false }));
			expect((await records()).find((record) => record.type === "job_membership")).toMatchObject({
				member: true,
				confirmed: listed,
			});
			expect(violations).toEqual([]);
		}
	});

	it("never claims membership when the creator itself was outside the job", async () => {
		const { enforcer, records } = await rig();
		await enforcer.onLaunch(launch("l", "job"));
		enforcer.onCommandStarted(started("l", { creatorInJob: false, breakaway: false }));
		expect((await records()).find((record) => record.type === "job_membership")).toMatchObject({ member: false });
	});

	it("raises tool_child_containment_violation when breakaway contradicts the ledgered containment, both ways", async () => {
		for (const [containment, breakaway] of [
			["job", true],
			["breakaway", false],
		] as const) {
			const { enforcer, violations, records } = await rig();
			await enforcer.onLaunch(launch("l", containment));
			enforcer.onCommandStarted(started("l", { creatorInJob: true, breakaway }));
			expect(violations).toEqual([
				{
					launchId: "l",
					jobId: "j1",
					reason: "breakaway_contradicts_containment",
					code: "tool_child_containment_violation",
				},
			]);
			expect((await records()).some((record) => record.type === "job_membership")).toBe(false);
		}
	});
});
