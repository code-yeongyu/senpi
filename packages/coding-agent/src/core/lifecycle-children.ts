import { readHumanWait } from "./lifecycle-attention.ts";
import { readWaitItems } from "./lifecycle-wait-items.ts";
import type { ChildLifecycleReport, LifecycleWaits, SessionLifecycleState } from "./session-lifecycle-types.ts";
import type { SessionEntry } from "./session-manager.ts";
import { isRecord } from "./work-custody-record.ts";

export interface ChildLifecycleStore {
	readonly entries: readonly SessionEntry[];
	append(report: ChildLifecycleReport): void;
	changed(): void;
}

export class LifecycleChildren {
	private readonly records = new Map<string, ChildLifecycleReport>();
	private readonly store: ChildLifecycleStore;
	constructor(store: ChildLifecycleStore) {
		this.store = store;
		for (const entry of store.entries) {
			if (entry.type !== "custom" || entry.customType !== "child-lifecycle") continue;
			const report = readChildReport(entry.data);
			if (report) this.accept(report, false);
		}
	}

	get reports(): readonly ChildLifecycleReport[] {
		return [...this.records.values()];
	}

	get activeCount(): number {
		return this.reports.filter((report) => report.terminal === undefined).length;
	}

	report(report: ChildLifecycleReport): void {
		const parsed = readChildReport(report);
		if (!parsed) throw new Error("Invalid child lifecycle report");
		if (!this.accept(parsed, true)) return;
		this.store.changed();
	}

	private accept(report: ChildLifecycleReport, persist: boolean): boolean {
		const previous = this.records.get(report.taskId);
		if (
			previous &&
			(report.runEpoch < previous.runEpoch ||
				(report.runEpoch === previous.runEpoch &&
					(previous.terminal !== undefined || report.generation <= previous.generation)))
		)
			return false;
		// A terminal is final within its run epoch; only a new run epoch replaces it.
		// Human waits remain runner-owned until an explicit child-to-human bridge exists.
		const accepted: ChildLifecycleReport = {
			...report,
			...(report.waitingOn ? { waitingOn: { ...report.waitingOn, human: [] } } : {}),
		};
		if (persist) this.store.append(accepted);
		this.records.set(report.taskId, accepted);
		return true;
	}
}

export function readLifecycleState(value: unknown): SessionLifecycleState | undefined {
	switch (value) {
		case "running":
		case "waiting_children":
		case "waiting_background":
		case "waiting_human":
		case "paused":
		case "held":
		case "done":
		case "failed":
		case "cancelled":
			return value;
		default:
			return undefined;
	}
}

/** The one reader of a durable or reported `waitingOn`; named detail never invalidates the counts. */
export function readWaits(value: unknown): LifecycleWaits | undefined {
	if (!isRecord(value) || typeof value.children !== "number") return undefined;
	const background: LifecycleWaits["background"][number][] = [];
	if (Array.isArray(value.background)) {
		for (const source of value.background) {
			if (!isRecord(source) || typeof source.source !== "string" || typeof source.activeCount !== "number") continue;
			background.push({
				source: source.source,
				activeCount: source.activeCount,
				...readWaitItems(source.items, source.omittedItems),
				...(typeof source.retryAtMs === "number" ? { retryAtMs: source.retryAtMs } : {}),
			});
		}
	}
	const human = Array.isArray(value.human)
		? value.human.flatMap((request) => {
				const wait = readHumanWait(request);
				return wait ? [wait] : [];
			})
		: [];
	const childSources: NonNullable<LifecycleWaits["childSources"]>[number][] = [];
	if (Array.isArray(value.childSources))
		for (const source of value.childSources) {
			if (!isRecord(source) || typeof source.source !== "string" || typeof source.activeCount !== "number") continue;
			childSources.push({
				source: source.source,
				activeCount: source.activeCount,
				...readWaitItems(source.items, source.omittedItems),
			});
		}
	const reports: NonNullable<LifecycleWaits["childReports"]>[number][] = [];
	if (Array.isArray(value.childReports))
		for (const report of value.childReports) {
			if (!isRecord(report)) continue;
			const state = readLifecycleState(report.state);
			if (
				!state ||
				typeof report.taskId !== "string" ||
				typeof report.childSessionId !== "string" ||
				typeof report.runEpoch !== "number" ||
				!Number.isSafeInteger(report.runEpoch) ||
				report.runEpoch < 0
			)
				continue;
			reports.push({
				taskId: report.taskId,
				childSessionId: report.childSessionId,
				runEpoch: report.runEpoch,
				state,
				...(typeof report.label === "string" ? { label: report.label } : {}),
				...(typeof report.since === "string" && Number.isFinite(Date.parse(report.since))
					? { since: report.since }
					: {}),
			});
		}
	reports.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
	const childReportsOmitted =
		Math.max(0, reports.length - 32) +
		(typeof value.childReportsOmitted === "number" &&
		Number.isSafeInteger(value.childReportsOmitted) &&
		value.childReportsOmitted > 0
			? value.childReportsOmitted
			: 0);
	return {
		children: value.children,
		background,
		human,
		...(childSources.length ? { childSources } : {}),
		...(reports.length ? { childReports: reports.slice(0, 32) } : {}),
		...(childReportsOmitted ? { childReportsOmitted } : {}),
	};
}

function readChildReport(value: unknown): ChildLifecycleReport | undefined {
	if (!isRecord(value)) return undefined;
	const state = readLifecycleState(value.state);
	if (
		!state ||
		typeof value.taskId !== "string" ||
		typeof value.childSessionId !== "string" ||
		typeof value.runEpoch !== "number" ||
		!Number.isSafeInteger(value.runEpoch) ||
		value.runEpoch < 0 ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 0
	)
		return undefined;
	const terminal = readTerminal(value.terminal);
	const waitingOn = readWaits(value.waitingOn);
	return {
		taskId: value.taskId,
		childSessionId: value.childSessionId,
		runEpoch: value.runEpoch,
		generation: value.generation,
		state,
		...(typeof value.label === "string" ? { label: value.label } : {}),
		...(typeof value.since === "string" && Number.isFinite(Date.parse(value.since)) ? { since: value.since } : {}),
		...(waitingOn ? { waitingOn } : {}),
		...(terminal === undefined ? {} : { terminal }),
	};
}

function readTerminal(value: unknown): ChildLifecycleReport["terminal"] {
	switch (value) {
		case "completed":
		case "error":
		case "lost":
		case "interrupted":
		case "cancelled":
			return value;
		default:
			return undefined;
	}
}
