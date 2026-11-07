import type { TerminalMonitorStateEvent } from "../monitor-state-event.ts";

/** How the user must act on a block, as OSC 7501 names it: a permission approval or a typed answer. */
export type HerdrBlockedKind = "permission" | "question";

export interface HerdrBlock {
	readonly label?: string;
	readonly kind?: HerdrBlockedKind;
}

export interface HerdrState {
	readonly blocked: ReadonlyMap<string, HerdrBlock>;
	readonly turnActive: boolean;
	readonly childCount: number;
	readonly monitorCount: number;
	/** Live monitors with no deadline (persistent watches, or watches without a timeout): they may never fire. */
	readonly openEndedMonitorCount: number;
	readonly wakeSources: ReadonlyMap<string, number>;
}

export type HerdrStateEvent =
	| { type: "blocked"; active: boolean; id: string; label?: string; kind?: HerdrBlockedKind }
	| { type: "turn"; active: boolean }
	| { type: "children"; count: number }
	| { type: "monitors"; count: number; openEnded: number }
	| { type: "wake-source"; source: string; count: number };

export interface HerdrReport {
	state: "blocked" | "working" | "idle";
	message?: string;
}

/** Wake sources whose work is already reported through a dedicated field or the blocked state. */
const REPRESENTED_WAKE_SOURCES: ReadonlySet<string> = new Set(["terminal-monitors", "senpi-task", "ask-user"]);

/**
 * Wake sources that may stay live with no end in sight (a server left running). Once the turn has ended they are named
 * in the message of an idle report instead of keeping the pane working forever; every other source is bounded work
 * that will start a turn and keeps the pane working (#6150). Monitors are split per watch by `openEndedMonitors`.
 */
const OPEN_ENDED_WAKE_SOURCES: ReadonlySet<string> = new Set(["terminal-background-sessions"]);

/**
 * How many of the broadcast watches have no deadline: a persistent watch, or one with no timeout. A one-shot watch
 * with a deadline either fires or times out, and both wake the session, so it is bounded. A payload without per-watch
 * detail counts none as open-ended, keeping the pane working as before the split.
 */
export function openEndedMonitors(event: TerminalMonitorStateEvent): number {
	return (event.monitors ?? []).filter((watch) => watch.persistent === true || typeof watch.deadlineMs !== "number")
		.length;
}

const WAKE_SOURCE_LABELS: Readonly<Record<string, readonly [singular: string, plural: string]>> = {
	"terminal-background-sessions": ["background session", "background sessions"],
	"senpi-codemode": ["detached eval cell", "detached eval cells"],
	"omo-dag": ["DAG run", "DAG runs"],
	"loop-guard-hard-stop": ["loop-guard recovery pending", "loop-guard recoveries pending"],
};

export function initialHerdrState(): HerdrState {
	return {
		blocked: new Map(),
		turnActive: false,
		childCount: 0,
		monitorCount: 0,
		openEndedMonitorCount: 0,
		wakeSources: new Map(),
	};
}

export function reduceHerdrState(state: HerdrState, event: HerdrStateEvent): HerdrState {
	switch (event.type) {
		case "turn":
			return { ...state, turnActive: event.active };
		case "children":
			return { ...state, childCount: event.count };
		case "monitors":
			return { ...state, monitorCount: event.count, openEndedMonitorCount: Math.min(event.openEnded, event.count) };
		case "wake-source": {
			if ((state.wakeSources.get(event.source) ?? 0) === event.count) return state;
			const wakeSources = new Map(state.wakeSources);
			if (event.count > 0) wakeSources.set(event.source, event.count);
			else wakeSources.delete(event.source);
			return { ...state, wakeSources };
		}
		case "blocked": {
			if (state.blocked.has(event.id) === event.active) return state;
			const blocked = new Map(state.blocked);
			if (event.active) blocked.set(event.id, { label: event.label, kind: event.kind });
			else blocked.delete(event.id);
			return { ...state, blocked };
		}
	}
}

export function selectHerdrReport(state: HerdrState): HerdrReport {
	if (state.blocked.size > 0) return { state: "blocked", message: state.blocked.values().next().value?.label };
	const parts: string[] = [];
	let bounded = false;
	const childCount = Math.max(state.childCount, state.wakeSources.get("senpi-task") ?? 0);
	if (childCount > 0) {
		parts.push(`${childCount} subagent${childCount === 1 ? "" : "s"} running`);
		bounded = true;
	}
	if (state.monitorCount > 0) parts.push(`${state.monitorCount} monitor${state.monitorCount === 1 ? "" : "s"} live`);
	if (state.monitorCount > state.openEndedMonitorCount) bounded = true;
	for (const [source, count] of [...state.wakeSources].sort(([left], [right]) => left.localeCompare(right))) {
		if (REPRESENTED_WAKE_SOURCES.has(source)) continue;
		const label = WAKE_SOURCE_LABELS[source];
		parts.push(label === undefined ? `${count} ${source}` : `${count} ${count === 1 ? label[0] : label[1]}`);
		if (!OPEN_ENDED_WAKE_SOURCES.has(source)) bounded = true;
	}
	const reported = state.turnActive || bounded ? "working" : "idle";
	return parts.length > 0 ? { state: reported, message: parts.join(" + ") } : { state: reported };
}

/** The kind of the block the report shows, the oldest open one, matching `selectHerdrReport`'s message. */
export function selectHerdrBlockedKind(state: HerdrState): HerdrBlockedKind | undefined {
	return state.blocked.values().next().value?.kind;
}

export function isHerdrBlockedEvent(
	data: unknown,
): data is { active: boolean; id: string; label?: string; kind?: HerdrBlockedKind } {
	return (
		typeof data === "object" &&
		data !== null &&
		"active" in data &&
		typeof data.active === "boolean" &&
		"id" in data &&
		typeof data.id === "string" &&
		data.id.length > 0 &&
		(!("label" in data) || data.label === undefined || typeof data.label === "string") &&
		(!("kind" in data) || data.kind === undefined || data.kind === "permission" || data.kind === "question")
	);
}
