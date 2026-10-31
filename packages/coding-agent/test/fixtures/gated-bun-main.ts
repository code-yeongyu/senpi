// Bun-runtime fixture for the gated Bun globals (senpi#3566 todo 4): a real channel, the server enforcer, the child
// gate and one worker running gated Bun.spawn / Bun.spawnSync / Bun.$. Prints one JSON line with what it observed.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectChannel, openChannelListener } from "../../src/modes/rpc/tool-child/channel.ts";
import { DescendantsLedger, LaunchLog } from "../../src/modes/rpc/tool-child/descendants.ts";
import { defaultGroupProbes } from "../../src/modes/rpc/tool-child/group-ownership.ts";
import { type BarrierViolation, LaunchEnforcer } from "../../src/modes/rpc/tool-child/launch-enforcer.ts";
import { LaunchGate } from "../../src/modes/rpc/tool-child/launch-gate.ts";
import type { WorkerLaunchMessage } from "../../src/modes/rpc/tool-child/worker-launch.ts";

const root = await mkdtemp(join(tmpdir(), "tgb-"));
const listener = await openChannelListener({ dir: join(root, "ch"), generation: 1 });
const childSide = await connectChannel(listener.env);
const serverSide = await listener.accepted;
await listener.close();
const violations: BarrierViolation[] = [];
const log = new LaunchLog(join(root, "launches.jsonl"));
const enforcer = new LaunchEnforcer({
	generation: 1,
	ledger: new DescendantsLedger(join(root, "descendants.ledger")),
	log,
	sendAck: (launchId) => serverSide.send({ type: "launch_ack", launchId }),
	onViolation: (violation) => violations.push(violation),
	leaderStart: (pid) => defaultGroupProbes.startOf(pid),
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
const workerFile = process.argv[2] ?? "./gated-bun-worker.ts";
const worker = new Worker(new URL(workerFile, import.meta.url), {
	workerData: {
		buffer: gate.clock.buffer,
		barrierClock: gate.clock.buffer,
		jobId: "job-1",
		marker: join(root, "started"),
	},
} as WorkerOptions);
const result = await new Promise<Record<string, unknown>>((resolve) => {
	worker.addEventListener(
		"message",
		(event: MessageEvent<WorkerLaunchMessage | { kind: "result"; value: Record<string, unknown> }>) => {
			const message = event.data;
			if (message.kind === "result") resolve(message.value);
			else gate.handleWorker(message);
		},
	);
});
worker.terminate();
await log.settled();
const records = (await readFile(log.path, "utf8"))
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as Record<string, unknown>);
childSide.close();
serverSide.close();
enforcer.dispose();
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ result, violations, records }));
process.exit(0);
