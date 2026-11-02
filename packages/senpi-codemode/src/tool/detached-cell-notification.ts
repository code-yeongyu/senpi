import type { EvalDetachedCellNotification, EvalDetachedCellSnapshot } from "./detached-cell-manager.ts";
import { interruptionStateNote, unknownInterruptionStateNote } from "./interrupt-note.ts";
import type { EvalKernelState, EvalMemoryDetails } from "./types.ts";

/**
 * A detached cell's completion carries the same text its result would have shown in the foreground: the output sink
 * already bounded it (the configured head, the tail, the middle marker and the artifact notice), plus its images.
 */
export function buildDetachedCellNotification(snapshot: EvalDetachedCellSnapshot): EvalDetachedCellNotification {
	const images = snapshot.result.content.filter((part) => part.type === "image");
	return { cellId: snapshot.cellId, content: notificationText(snapshot, textContent(snapshot)), images };
}

function notificationText(cell: EvalDetachedCellSnapshot, output: string): string {
	return [
		`<system-reminder>Detached eval cell ${cell.cellId} (${cell.language}) ${outcomeOf(cell)}.`,
		output.length === 0 ? "(no output)" : output,
		`${stateNoteOf(cell)}</system-reminder>`,
	].join("\n");
}

function textContent(cell: EvalDetachedCellSnapshot): string {
	return (
		cell.result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n") || cell.outputTail
	);
}

function outcomeOf(cell: EvalDetachedCellSnapshot): string {
	if (cell.hardLimitSeconds !== undefined) return `was killed at the ${cell.hardLimitSeconds}s hard limit`;
	if (cell.runBudgetSeconds !== undefined)
		return `was killed after exhausting its ${cell.runBudgetSeconds}s run budget (own execution time; host tool calls excluded)`;
	if (cell.state === "completed") return "completed";
	if (cell.state === "cancelled") return "cancelled";
	return "failed";
}

function stateNoteOf(cell: EvalDetachedCellSnapshot): string {
	if (cell.state !== "cancelled") {
		const kernelState = cell.result.details?.kernelState;
		return kernelState === undefined ? memoryStateNote(cell.result.details?.memory) : KERNEL_STATE_NOTES[kernelState];
	}
	const note = interruptionStateNote(cell.language, cell.stateRetained) ?? unknownInterruptionStateNote(cell.language);
	return cell.interruptNote === undefined ? note : `${note} ${cell.interruptNote.trim()}`;
}

/** A kernel death decides what survived, whatever the memory report says. */
const KERNEL_STATE_NOTES: Readonly<Record<EvalKernelState, string>> = {
	lost: "The kernel died while this cell ran - every global is lost; the next eval cell runs on a fresh kernel.",
	restarted:
		"The kernel was restarted before this cell ran - globals from earlier cells are gone; this cell's variables are available to the next eval cell.",
	"not-run": "This cell never ran and changed no kernel state.",
};

export function memoryStateNote(memory: EvalMemoryDetails | undefined): string {
	if (memory?.overCeiling === true)
		return "Kernel memory is over its ceiling - the kernel restarts before the next eval cell and every global is lost.";
	if (memory?.recycled === true)
		return "The kernel was restarted before this cell ran - globals from earlier cells are gone; this cell's variables are available to the next eval cell.";
	return "Kernel state updated - variables are available to the next eval cell.";
}
