import { fauxAssistantMessage, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { JOB_WIDGET_RESPOND_TOOL, type JobWidgetState } from "../../src/core/extensions/builtin/job-widgets/index.ts";
import jobWidgetsExtension from "../../src/core/extensions/builtin/job-widgets/extension.ts";
import registerTerminalExtension from "../../src/core/extensions/builtin/terminal/index.ts";
import type { ExtensionBindings } from "../../src/core/agent-session.ts";
import type { EventBus } from "../../src/core/event-bus.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

export const BLENDER_SPEC = {
	title: "Blender render",
	rules: [{ from: "out", match: String.raw`^\s*Time: \d+:(?P<frame_s>[\d.]+) \(Saving`, count: "frames" }],
	blocks: [{ kind: "spark", field: "frame_s", label: "seconds per frame", unit: "s" }],
	headline: { field: "frames", agg: "count", label: "rendered" },
};

/** Two Blender frames: progress lines and the per-frame `Time:` lines the spec counts. */
export const BLENDER_PRINT = String.raw`printf 'Fra:1 Mem:2104.32M | Rendering 64 / 64 samples\n Time: 00:03.90 (Saving: 00:00.09)\nFra:2 Mem:2110.10M | Rendering 64 / 64 samples\n Time: 00:04.30 (Saving: 00:00.10)\n'`;

/** The fake author: the faux model answers every spec request with the Blender spec. */
export const answerWithBlenderSpec: FauxResponseFactory = () =>
	fauxAssistantMessage([fauxToolCall(JOB_WIDGET_RESPOND_TOOL, BLENDER_SPEC)], { stopReason: "toolUse" });

/** States as they arrive, with a bounded wait for the first one a predicate accepts. */
export class StateLog {
	readonly states: JobWidgetState[] = [];
	readonly #waiters = new Set<() => void>();

	push(state: JobWidgetState): void {
		this.states.push(state);
		for (const waiter of [...this.#waiters]) waiter();
	}

	waitFor(accept: (state: JobWidgetState, index: number) => boolean, timeoutMs = 20_000): Promise<JobWidgetState> {
		return new Promise((resolve, reject) => {
			const check = (): void => {
				const found = this.states.find(accept);
				if (!found) return;
				this.#waiters.delete(check);
				clearTimeout(timer);
				resolve(found);
			};
			const timer = setTimeout(() => {
				this.#waiters.delete(check);
				reject(new Error(`no matching job_widget_state in ${timeoutMs} ms: ${JSON.stringify(this.states)}`));
			}, timeoutMs);
			this.#waiters.add(check);
			check();
		});
	}
}

export function jobState(state: JobWidgetState, id: string): string | undefined {
	return state.jobs.find((job) => job.id === id)?.state;
}

export async function createJobWidgetHarness(
	jobWidgets: Record<string, unknown>,
	bindings: ExtensionBindings = {},
): Promise<{
	harness: Harness;
	log: StateLog;
	sessionId: string;
	bus: EventBus;
}> {
	const log = new StateLog();
	let bus: EventBus | undefined;
	const harness = await createHarness({
		fileSettings: true,
		settings: { jobWidgets },
		initialActiveToolNames: ["bash", "bash_output", "bash_input", "kill_bash"],
		extensionFactories: [
			registerTerminalExtension,
			jobWidgetsExtension,
			(pi: ExtensionAPI) => {
				pi.on("session_start", () => {
					bus = pi.events;
					pi.events.on("job_widget_state", (data) => log.push(data as JobWidgetState));
				});
			},
		],
	});
	await harness.session.bindExtensions(bindings);
	if (!bus) throw new Error("session_start did not run");
	return { harness, log, sessionId: harness.sessionManager.getSessionId(), bus };
}

/** Resolves when the terminal's background sessions go from some running to none. */
export function backgroundIdle(bus: EventBus): Promise<void> {
	return new Promise((resolve) => {
		let sawRunning = false;
		const off = bus.on("wake_source_state", (data) => {
			const event = data as { source?: unknown; activeCount?: unknown };
			if (event.source !== "terminal-background-sessions" || typeof event.activeCount !== "number") return;
			if (event.activeCount > 0) sawRunning = true;
			else if (sawRunning) {
				off();
				resolve();
			}
		});
	});
}

export function bashIdOf(result: { details?: unknown }): string {
	const id = (result.details as { bash_id?: unknown } | undefined)?.bash_id;
	if (typeof id !== "string") throw new Error(`no bash_id in ${JSON.stringify(result.details)}`);
	return id;
}
