/**
 * Offers each background session (`run_in_background`, or a foreground command auto-detached at
 * its window) to the session's job widgets: its decoded output feeds a text tap, its exit settles
 * the widget, its eviction forgets it. A session someone typed into (`bash_input`) is interactive,
 * not a metric stream, and is withdrawn. Monitor watchers never come here: they are not background
 * sessions. Sessions living on a tool child have no runtime in this process and are not tapped.
 */
import { registerJobWidgetSource } from "../job-widgets/session-host.ts";
import { TextTap } from "../job-widgets/text-tap.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";

const OUTPUT_SOURCE_ID = "out";
const OUTPUT_SOURCE_LABEL = "command output";

const untaps = new WeakMap<TerminalRuntimeSession, () => void>();

export function tapBackgroundSession(
	sessionId: string | undefined,
	id: string,
	runtime: TerminalRuntimeSession,
	brief: { readonly command: string; readonly description: string },
): void {
	if (sessionId === undefined || untaps.has(runtime)) return;
	const tap = new TextTap(OUTPUT_SOURCE_ID, OUTPUT_SOURCE_LABEL);
	const handle = registerJobWidgetSource({
		sessionId,
		id,
		kind: "bash",
		sources: [tap],
		brief: {
			command: brief.command,
			...(brief.description === brief.command ? {} : { intent: brief.description }),
		},
		startedAtMs: runtime.startedAtMs,
	});
	if (handle === undefined) return;
	tap.append(runtime.fullOutput());
	const stopOutput = runtime.onOutput((chunk) => {
		tap.append(chunk);
		handle.notify();
	});
	let stopDispose = (): void => {};
	const untap = (): void => {
		untaps.delete(runtime);
		stopOutput();
		stopDispose();
		handle.dispose();
	};
	untaps.set(runtime, untap);
	stopDispose = runtime.onDispose(untap);
	runtime.session.onExit(() => {
		tap.close();
		handle.settle();
	});
	handle.notify();
}

export function untapBackgroundSession(runtime: TerminalRuntimeSession | null | undefined): void {
	if (runtime) untaps.get(runtime)?.();
}
