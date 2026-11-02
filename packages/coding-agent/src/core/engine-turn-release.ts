import type { EngineTurnHold } from "./engine-turn-hold.ts";
import type { CustomMessage } from "./messages.ts";

/** Never uses the native follow-up queue: its `all` mode may combine unrelated sources. */
export class EngineTurnRelease {
	private running: Promise<void> | undefined;

	resume(
		hold: EngineTurnHold,
		sendThroughAgentEnd: (message: CustomMessage, admit: () => boolean) => Promise<boolean>,
		releaseSources: (sources: Record<string, number>) => Promise<void>,
	): Promise<void> {
		if (this.running) return this.running;
		if (!hold.held || hold.releasing) return Promise.resolve();
		const sources = hold.releaseAll("resume_session");
		const generation = hold.generation;
		const run = async () => {
			for (const { source, noticeIds, message } of hold.messages()) {
				if (hold.generation !== generation) return;
				// sendCustomMessage resolves only after the run's agent_end handlers settle.
				const delivered = await sendThroughAgentEnd(message, () => hold.consume(source, noticeIds));
				if (hold.generation !== generation) return;
				if (!delivered) {
					hold.rejectInput();
					return;
				}
			}
			if (hold.generation !== generation) return;
			const remaining = hold.finish();
			if (!hold.held) await releaseSources({ ...sources, ...remaining });
		};
		this.running = run()
			.catch((error: unknown) => {
				if (hold.generation === generation) hold.rejectInput();
				throw error;
			})
			.finally(() => {
				this.running = undefined;
			});
		return this.running;
	}
}
