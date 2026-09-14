export interface HerdrState {
	readonly blocked: ReadonlyMap<string, string | undefined>;
	readonly turnActive: boolean;
	readonly childCount: number;
	readonly monitorCount: number;
}

export type HerdrStateEvent =
	| { type: "blocked"; active: boolean; id: string; label?: string }
	| { type: "turn"; active: boolean }
	| { type: "children"; count: number }
	| { type: "monitors"; count: number };

export interface HerdrReport {
	state: "blocked" | "working" | "idle";
	message?: string;
}

export function initialHerdrState(): HerdrState {
	return { blocked: new Map(), turnActive: false, childCount: 0, monitorCount: 0 };
}

export function reduceHerdrState(state: HerdrState, event: HerdrStateEvent): HerdrState {
	switch (event.type) {
		case "turn":
			return { ...state, turnActive: event.active };
		case "children":
			return { ...state, childCount: event.count };
		case "monitors":
			return { ...state, monitorCount: event.count };
		case "blocked": {
			if (state.blocked.has(event.id) === event.active) return state;
			const blocked = new Map(state.blocked);
			if (event.active) blocked.set(event.id, event.label);
			else blocked.delete(event.id);
			return { ...state, blocked };
		}
	}
}

export function selectHerdrReport(state: HerdrState): HerdrReport {
	if (state.blocked.size > 0) return { state: "blocked", message: state.blocked.values().next().value };
	const parts: string[] = [];
	if (state.childCount > 0) parts.push(`${state.childCount} subagent${state.childCount === 1 ? "" : "s"} running`);
	if (state.monitorCount > 0) parts.push(`${state.monitorCount} monitor${state.monitorCount === 1 ? "" : "s"} live`);
	return state.turnActive || parts.length > 0
		? { state: "working", message: parts.length > 0 ? parts.join(" + ") : undefined }
		: { state: "idle" };
}

export function isHerdrBlockedEvent(data: unknown): data is { active: boolean; id: string; label?: string } {
	return (
		typeof data === "object" &&
		data !== null &&
		"active" in data &&
		typeof data.active === "boolean" &&
		"id" in data &&
		typeof data.id === "string" &&
		data.id.length > 0 &&
		(!("label" in data) || data.label === undefined || typeof data.label === "string")
	);
}
