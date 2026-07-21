import { formatWorkingElapsedSeconds } from "./working-status.ts";

export interface ToolProgressDetails {
	readonly activity?: string;
	readonly startedAt: number;
	readonly maxWaitMs?: number;
}

export function readToolProgress(details: unknown): ToolProgressDetails | undefined {
	if (typeof details !== "object" || details === null || !("progress" in details)) return undefined;
	const progress = details.progress;
	if (typeof progress !== "object" || progress === null || !("startedAt" in progress)) return undefined;
	if (typeof progress.startedAt !== "number" || !Number.isFinite(progress.startedAt)) return undefined;
	if ("activity" in progress && typeof progress.activity !== "string") return undefined;
	if ("maxWaitMs" in progress && (typeof progress.maxWaitMs !== "number" || !Number.isFinite(progress.maxWaitMs))) {
		return undefined;
	}
	const activity = "activity" in progress && typeof progress.activity === "string" ? progress.activity : undefined;
	const maxWaitMs = "maxWaitMs" in progress && typeof progress.maxWaitMs === "number" ? progress.maxWaitMs : undefined;
	return { activity, startedAt: progress.startedAt, maxWaitMs };
}

export function formatToolProgressLine(progress: ToolProgressDetails, now: number, spinnerFrame?: number): string {
	const activity = progress.activity || "working";
	const elapsed = formatWorkingElapsedSeconds((now - progress.startedAt) / 1_000);
	const maxWait =
		progress.maxWaitMs === undefined ? "" : ` / max ${Math.max(0, Math.floor(progress.maxWaitMs / 1_000))}s`;
	const spinner = spinnerFrame === undefined ? "⏵" : ["⏵", "⏷", "⏴", "⏶"][spinnerFrame % 4];
	return `${spinner} ${activity} · ${elapsed}${maxWait}`;
}
