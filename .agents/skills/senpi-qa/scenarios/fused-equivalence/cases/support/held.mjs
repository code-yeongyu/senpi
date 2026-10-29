// Drive helpers for cases whose tools are held on fake-server barriers (fixtures/held-tools.mjs).
//
// Every release is recorded into O5's `extra` as `{ release, arrivedBefore }`: the barriers whose bodies were already in
// flight when the case released this one. That set is what tells a parallel batch (all bodies in flight together) from
// a sequential one (the next body starts only after the previous finished), deterministically.
import { join } from "node:path";
import { FIXTURES } from "./case-run.mjs";

export const HELD_TOOLS = join(FIXTURES, "held-tools.mjs");

/** Start tracking arrivals for these barrier names; call before the prompt that dispatches the tools. */
export function watchBarriers(run, names) {
	const arrived = new Set();
	for (const name of names) run.server.barrierArrived(name).then(() => arrived.add(name));
	return arrived;
}

/** Wait until every named barrier has a body waiting on it. */
export const allArrived = (run, names) => Promise.all(names.map((name) => run.server.barrierArrived(name)));

/**
 * For each step: wait for its body to arrive, record what was in flight, release it, wait for its tool_execution_end.
 * `arrived` comes from watchBarriers().
 */
export async function releaseInOrder(run, arrived, steps) {
	for (const { barrier, toolCallId } of steps) {
		await run.server.barrierArrived(barrier);
		await Promise.resolve();
		run.effects.push({ release: barrier, arrivedBefore: [...arrived].sort() });
		const ended = run.nextEvent((e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId);
		run.server.releaseBarrier(barrier);
		await ended;
	}
}

/** Prompt, run the held steps, and wait for the turn's agent_idle. */
export async function promptHeld(run, message, steps) {
	const arrived = watchBarriers(
		run,
		steps.map((step) => step.barrier),
	);
	const idle = run.nextEvent((e) => e.type === "agent_idle");
	await run.send({ type: "prompt", message });
	return { arrived, idle };
}
