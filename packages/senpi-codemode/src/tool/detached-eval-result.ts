import type { AgentToolResult } from "@code-yeongyu/senpi";
import type {
	EvalDetachedCellManager,
	EvalDetachedCellSnapshot,
	EvalDetachedCellState,
} from "./detached-cell-manager.ts";
import { interruptionStateNote } from "./interrupt-note.ts";
import type {
	EvalCellResult,
	EvalControlInput,
	EvalListDetails,
	EvalListedCell,
	EvalResultDetails,
	EvalToolDetails,
	EvalToolInput,
} from "./types.ts";

export class EvalBackgroundCapacityError extends Error {
	readonly code = "eval_background_capacity_reached";
	readonly name = "EvalBackgroundCapacityError";

	constructor(cap: number, cellId: string, foregroundMs: number, liveCellIds: readonly string[]) {
		super(
			`Background capacity (${cap}) reached: cell ${cellId} ran ${Math.floor(foregroundMs / 1_000)}s in the foreground and was cancelled when the foreground window elapsed. Live cells: ${liveCellIds.join(", ")}. Stop one with eval({ action: "stop", cell_id }) or wait for a notification, then re-run this step.`,
		);
	}
}

export async function executeEvalControl(
	cellManager: EvalDetachedCellManager,
	request: EvalControlInput,
): Promise<AgentToolResult<EvalResultDetails>> {
	if (request.action === "list") return createEvalListResult(cellManager);
	const snapshot =
		request.action === "stop" ? await cellManager.stop(request.cell_id) : cellManager.peek(request.cell_id);
	return createDetachedControlResult(snapshot);
}

function createEvalListResult(cellManager: EvalDetachedCellManager): AgentToolResult<EvalListDetails> {
	const { live, recent } = cellManager.list();
	const snapshots = [...live, ...recent];
	const cells: EvalListedCell[] = snapshots.map((snapshot) => {
		const summary = snapshot.result.details.summary;
		return {
			cellId: snapshot.cellId,
			language: snapshot.language,
			state: snapshot.state,
			startedAtMs: snapshot.startedAtMs,
			...(snapshot.queuedBehind === undefined ? {} : { queuedBehind: [...snapshot.queuedBehind] }),
			...(summary ? { summary } : {}),
		};
	});
	const text = snapshots
		.map((snapshot, index) => {
			const cell = cells[index];
			const preview = (cell.summary || snapshot.result.details.cells?.[0]?.code?.slice(0, 60) || "").replace(
				/\s+/gu,
				" ",
			);
			const elapsed = Math.floor(snapshot.result.details.durationMs / 1000);
			const queued = cell.queuedBehind === undefined ? "" : ` ${queuedPhrase(cell.queuedBehind, cell.language)}`;
			return `${cell.cellId} ${cell.language} ${cell.state} ${elapsed}s${queued} - ${preview}`;
		})
		.join("\n");
	return {
		content: [{ type: "text", text: text || "No eval cells are live; recent: none" }],
		details: { action: "list", cells },
	};
}

export function resultAfterDetach(
	snapshot: EvalDetachedCellSnapshot,
	input: EvalToolInput,
	otherLiveCells: number,
): AgentToolResult<EvalToolDetails> {
	if (snapshot.state !== "detached" && snapshot.state !== "running") return createDetachedControlResult(snapshot);
	const queuedBehind = snapshot.queuedBehind;
	const text =
		queuedBehind === undefined
			? `Eval cell ${snapshot.cellId} detached and is running in the ${input.language} kernel (${otherLiveCells} other live cells). Completion arrives as a notification; do not re-run it. eval({ action: "peek" | "stop", cell_id }) or eval({ action: "list" }).`
			: queuedBehind.length === 0
				? `Eval cell ${snapshot.cellId} is detached and waiting for the ${input.language} kernel to be ready; it runs first once the kernel is ready and completes as one notification. peek/stop/list with eval({ action, cell_id })`
				: `Eval cell ${snapshot.cellId} is queued behind ${queuedBehind.join(", ")} in the ${input.language} kernel and detached; it runs after ${queuedBehind.join(", ")} and completes as one notification. peek/stop/list with eval({ action, cell_id })`;
	return {
		content: [
			{
				type: "text",
				text,
			},
		],
		details: snapshot.result.details,
	};
}

export function createDetachedControlResult(snapshot: EvalDetachedCellSnapshot): AgentToolResult<EvalToolDetails> {
	const terminationNote =
		snapshot.state === "cancelled" ? interruptionStateNote(snapshot.language, snapshot.stateRetained) : undefined;
	const output = textContent(snapshot.result);
	const text = [
		`Eval cell ${snapshot.cellId} (${snapshot.language}) is ${snapshot.state}.`,
		output.length === 0 ? "(no buffered output)" : output,
		...(terminationNote === undefined ? [] : [terminationNote]),
		...(snapshot.interruptNote === undefined ? [] : [snapshot.interruptNote.trim()]),
	].join("\n");
	return {
		content: [{ type: "text", text }, ...snapshot.result.content.filter((part) => part.type === "image")],
		details: {
			...snapshot.result.details,
			...(snapshot.state === "failed" ? { isError: true } : {}),
		},
	};
}

export function resultForDetachedState(
	result: AgentToolResult<EvalToolDetails>,
	state: EvalDetachedCellState,
	durationMs: number,
	queuedBehind?: readonly string[],
): AgentToolResult<EvalToolDetails> {
	const details = result.details;
	const cells = details.cells ?? [];
	const nextCells =
		cells.length === 0
			? []
			: cells.map((cell, index) => {
					if (index !== 0) return { ...cell };
					const { queuedBehind: _previousQueue, ...current } = cell;
					return {
						...current,
						durationMs: terminalDuration(cell, state, durationMs),
						status: state === "detached" && queuedBehind !== undefined ? "queued" : cellStatus(state),
						...(queuedBehind === undefined ? {} : { queuedBehind }),
					};
				});
	return {
		content: result.content.map((part) => ({ ...part })),
		details: {
			...details,
			durationMs: terminalDuration(details, state, durationMs),
			toolCalls: details.toolCalls.map((toolCall) => ({ ...toolCall })),
			...(details.statusEvents === undefined
				? {}
				: {
						statusEvents: details.statusEvents.map((event) => ({
							...event,
						})),
					}),
			...(nextCells.length === 0
				? {}
				: {
						cells: nextCells.map((cell) => ({
							...cell,
							...(cell.statusEvents === undefined
								? {}
								: {
										statusEvents: cell.statusEvents.map((event) => ({
											...event,
										})),
									}),
						})),
					}),
			...(details.jsonOutputs === undefined ? {} : { jsonOutputs: structuredClone(details.jsonOutputs) }),
		},
	};
}

function queuedPhrase(queuedBehind: readonly string[], language: string): string {
	return queuedBehind.length === 0
		? `waiting for the ${language} kernel to be ready`
		: `queued behind ${queuedBehind.join(", ")}`;
}

function textContent(result: AgentToolResult<EvalToolDetails>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function terminalDuration(
	value: { readonly durationMs?: number },
	state: EvalDetachedCellState,
	liveDurationMs: number,
): number {
	if (state === "completed" || state === "failed" || state === "cancelled") return value.durationMs ?? liveDurationMs;
	return liveDurationMs;
}

function cellStatus(state: EvalDetachedCellState): EvalCellResult["status"] {
	switch (state) {
		case "queued":
			return "queued";
		case "running":
			return "running";
		case "detached":
			return "detached";
		case "completed":
			return "complete";
		case "failed":
			return "error";
		case "cancelled":
			return "cancelled";
	}
}
