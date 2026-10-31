import { join } from "node:path";
import type { ToolChildChannel } from "./channel.ts";
import { DescendantsLedger, generationLedgerPath, LaunchLog } from "./descendants.ts";
import { defaultGroupProbes, type LedgeredGroup, type SweepOutcome, sweepGroups } from "./group-ownership.ts";
import { type BarrierViolation, LaunchEnforcer } from "./launch-enforcer.ts";
import type { ToolChildMessage } from "./protocol.ts";
import { readTestControls, TEST_CONTROL_DIR_ENV } from "./test-controls.ts";

const SLOT_QUERY_PREFIX = "query-slot-";

export interface GenerationBarrier {
	readonly ledger: DescendantsLedger;
	readonly log: LaunchLog;
	handle(frame: ToolChildMessage): boolean;
	teardown(child: LedgeredGroup | undefined): Promise<SweepOutcome[]>;
}

export function createGenerationBarrier(options: {
	readonly dir: string;
	readonly generation: number;
	readonly channel: ToolChildChannel;
	readonly onViolation: (violation: BarrierViolation) => void;
	readonly holdAck?: (launchId: string) => Promise<void>;
	readonly confirmMember?: (pid: number) => boolean;
}): GenerationBarrier {
	const controls = readTestControls(process.env);
	const holdAck =
		options.holdAck ??
		(controls.enabled("HOLD_LAUNCH_ACK")
			? (launchId: string) => controls.released(`release-${launchId}`)
			: undefined);
	const ledger = new DescendantsLedger(generationLedgerPath(options.dir, options.generation));
	const log = new LaunchLog(join(options.dir, "launches.jsonl"));
	const enforcer = new LaunchEnforcer({
		generation: options.generation,
		ledger,
		log,
		sendAck: (launchId) => options.channel.send({ type: "launch_ack", launchId }),
		onViolation: options.onViolation,
		leaderStart: (pid) => defaultGroupProbes.startOf(pid),
		...(holdAck === undefined ? {} : { holdAck }),
		...(options.confirmMember === undefined ? {} : { confirmMember: options.confirmMember }),
	});
	// Test-only: with SENPI_TOOL_CHILD_TRACE=1 a control file `query-slot-<launchId>.<n>` asks the child for that launch's
	// slot counts; the reply (`slot_state`) lands in launches.jsonl beside the launch it describes.
	const slotQueries =
		process.env.SENPI_TOOL_CHILD_TRACE === "1" && process.env[TEST_CONTROL_DIR_ENV] !== undefined
			? controls.watchPrefix(SLOT_QUERY_PREFIX, (name) => {
					const launchId = name.slice(SLOT_QUERY_PREFIX.length).replace(/\.[^.]*$/, "");
					options.channel.send({ type: "slot_query", launchId });
				})
			: undefined;
	return {
		ledger,
		log,
		handle(frame) {
			switch (frame.type) {
				case "launch":
					if (controls.enabled("DROP_CONTROL_BEFORE_ACK")) {
						options.channel.close();
						return true;
					}
					void enforcer.onLaunch(frame);
					return true;
				case "launch_proof":
					enforcer.onProof(frame);
					return true;
				case "launch_done":
					enforcer.onDone(frame);
					return true;
				case "command_started":
					enforcer.onCommandStarted(frame);
					return true;
				case "slot_state":
					void log.record({ ...frame });
					return true;
				default:
					return false;
			}
		},
		async teardown(child) {
			slotQueries?.close();
			await enforcer.recorded();
			enforcer.dispose();
			const owned: LedgeredGroup[] = ledger.entries().flatMap((entry) =>
				entry.pgid === undefined
					? []
					: [
							{
								launchId: entry.launchId,
								pgid: entry.pgid,
								leaderStart: entry.leaderStart,
								lifetime: entry.lifetime,
							},
						],
			);
			const outcomes =
				process.platform === "win32"
					? []
					: await sweepGroups(child === undefined ? owned : [...owned, child], {
							graceMs: 2_000,
							killWaitMs: 2_000,
						});
			await log.record({
				type: "teardown",
				generation: options.generation,
				outcomes: outcomes.map((o) => `${o.launchId}:${o.verdict}`).join(","),
			});
			await log.settled();
			await ledger.remove();
			return outcomes;
		},
	};
}
