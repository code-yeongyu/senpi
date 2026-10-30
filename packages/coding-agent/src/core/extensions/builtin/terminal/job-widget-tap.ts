/**
 * Offers each background session (`run_in_background`, or a foreground command auto-detached at
 * its window) to the session's job widgets: its decoded output feeds a text tap, its exit settles
 * the widget, its eviction forgets it. A session someone typed into (`bash_input`) is interactive,
 * not a metric stream, and is withdrawn. Monitor watchers never come here: they are not background
 * sessions. Sessions living on a tool child have no runtime in this process and are not tapped.
 *
 * An offer outlives the widgets it fed: when a reload turns the session's widgets off, every tap is
 * dropped (its handle went inert with the registry), and when they come back on, each offer still
 * running is tapped again, its output so far included.
 */
import { onJobWidgetSessionChange, registerJobWidgetSource } from "../job-widgets/session-host.ts";
import { TextTap } from "../job-widgets/text-tap.ts";
import type { JobWidgetSourceHandle } from "../job-widgets/registry.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";

const OUTPUT_SOURCE_ID = "out";
const OUTPUT_SOURCE_LABEL = "command output";

interface Tapped {
	readonly tap: TextTap;
	readonly handle: JobWidgetSourceHandle;
	readonly stopOutput: () => void;
}

interface Offer {
	readonly sessionId: string;
	readonly id: string;
	readonly runtime: TerminalRuntimeSession;
	readonly brief: { readonly command: string; readonly description: string };
	tapped: Tapped | undefined;
	withdrawn: boolean;
	exited: boolean;
}

const offers = new WeakMap<TerminalRuntimeSession, Offer>();
const offersBySession = new Map<string, Set<Offer>>();
let watchingSessions = false;

function watchSessions(): void {
	if (watchingSessions) return;
	watchingSessions = true;
	onJobWidgetSessionChange((sessionId, open) => {
		for (const offer of [...(offersBySession.get(sessionId) ?? [])]) {
			if (!open) detach(offer);
			else if (!offer.withdrawn && !offer.exited && !offer.tapped) attach(offer);
		}
	});
}

function attach(offer: Offer): void {
	const tap = new TextTap(OUTPUT_SOURCE_ID, OUTPUT_SOURCE_LABEL);
	const handle = registerJobWidgetSource({
		sessionId: offer.sessionId,
		id: offer.id,
		kind: "bash",
		sources: [tap],
		brief: {
			command: offer.brief.command,
			...(offer.brief.description === offer.brief.command ? {} : { intent: offer.brief.description }),
		},
		startedAtMs: offer.runtime.startedAtMs,
	});
	if (handle === undefined) return;
	tap.append(offer.runtime.fullOutput());
	const stopOutput = offer.runtime.onOutput((chunk) => {
		tap.append(chunk);
		handle.notify();
	});
	offer.tapped = { tap, handle, stopOutput };
	handle.notify();
}

function detach(offer: Offer): void {
	const tapped = offer.tapped;
	if (!tapped) return;
	offer.tapped = undefined;
	tapped.stopOutput();
	tapped.handle.dispose();
}

export function tapBackgroundSession(
	sessionId: string | undefined,
	id: string,
	runtime: TerminalRuntimeSession,
	brief: { readonly command: string; readonly description: string },
): void {
	if (sessionId === undefined || offers.has(runtime)) return;
	const offer: Offer = { sessionId, id, runtime, brief, tapped: undefined, withdrawn: false, exited: false };
	offers.set(runtime, offer);
	let sessionOffers = offersBySession.get(sessionId);
	if (!sessionOffers) {
		sessionOffers = new Set();
		offersBySession.set(sessionId, sessionOffers);
	}
	sessionOffers.add(offer);
	watchSessions();
	runtime.onDispose(() => {
		detach(offer);
		offers.delete(runtime);
		const remaining = offersBySession.get(sessionId);
		remaining?.delete(offer);
		if (remaining?.size === 0) offersBySession.delete(sessionId);
	});
	runtime.session.onExit(() => {
		offer.exited = true;
		offer.tapped?.tap.close();
		offer.tapped?.handle.settle();
	});
	attach(offer);
}

export function untapBackgroundSession(runtime: TerminalRuntimeSession | null | undefined): void {
	const offer = runtime ? offers.get(runtime) : undefined;
	if (!offer) return;
	offer.withdrawn = true;
	detach(offer);
}
