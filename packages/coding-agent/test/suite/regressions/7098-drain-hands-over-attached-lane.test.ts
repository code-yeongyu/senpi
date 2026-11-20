import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { opened } from "../rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";

// senpi#7098. A superseded generation kept every session a client was still attached to: the drain held automatic
// turns only for unattended sessions, so an attached lane chaining goal continuations and monitor wakes never went
// idle, and the predecessor ran beside its successor for hours. The drain now hands every session over at its next
// turn boundary: its running turn finishes, no automatic turn follows it here, it parks, and the generation exits.

const scratchDirs: string[] = [];
afterEach(async () => {
	for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("an attached session mid-turn parks at its turn boundary and the drained generation exits", async () => {
	const dir = realpathSync(await mkdtemp(join(tmpdir(), "senpi-7098-")));
	scratchDirs.push(dir);
	const exited = Promise.withResolvers<void>();
	const rig = createInProcessRig(dir, { onEmptyExit: () => exited.resolve() });
	const lanePath = join(dir, "lane.jsonl");
	const lane = opened(
		await rig.open("client", { cwd: dir, sessionPath: lanePath, retain_on_disconnect: true }),
		1,
	).sessionId;
	const turn = rig.turns.get(lanePath);
	if (turn === undefined) throw new Error("rig turn missing");
	turn.start();

	rig.router.beginDrain();
	await rig.settle();

	expect(turn.automaticTurnHolds).toBe(1);
	expect(rig.registry.peek(lane)?.attachments).toBe(1);

	turn.finish();
	await exited.promise;
	await rig.settle();

	expect(rig.registry.size).toBe(0);
});
