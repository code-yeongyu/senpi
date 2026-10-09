import { cellOfRejection } from "./cell-run-context.js";

const STACK_FRAMES = 3;

// An unhandled rejection is reported, never fatal: the kernel keeps its variables (the Node REPL and Jupyter norm). The
// report names the cell that started the work when it is known and lands on the cell running now, or on the next one.
// A burst is folded into one report plus a count, so a stopped loop cannot flood a cell's output.
export function createRejectionReports({ activeCell, emitText }) {
	let waiting = null;
	const shownInCell = new WeakMap();

	function report(reason) {
		const text = describe(reason, cellOfRejection(reason), activeCell());
		const cell = activeCell();
		if (cell === null || cell.released) {
			if (waiting === null) waiting = { text, more: 0 };
			else waiting.more++;
			return;
		}
		const shown = shownInCell.get(cell) ?? 0;
		shownInCell.set(cell, shown + 1);
		if (shown === 0) emitText(text);
	}

	return {
		report,
		startCell(cell) {
			if (waiting === null) return;
			emitText(`${waiting.text}${moreLine(waiting.more)}`);
			shownInCell.set(cell, 1);
			waiting = null;
		},
		finishCell(cell) {
			const shown = shownInCell.get(cell) ?? 0;
			if (shown > 1) emitText(moreLine(shown - 1));
		},
	};
}

function moreLine(more) {
	return more === 0 ? "" : `... and ${more} more unhandled promise ${more === 1 ? "rejection" : "rejections"}\n`;
}

function describe(reason, origin, running) {
	const where =
		origin === undefined
			? "(the cell that started it is unknown)"
			: origin === running && !origin.released
				? "in this cell"
				: `from cell ${origin.cellId}${origin.released ? ", after it was stopped" : ""}`;
	return `Unhandled promise rejection ${where}: ${summary(reason)}\n`;
}

function summary(reason) {
	if (!(reason instanceof Error)) return String(reason);
	const frames = (reason.stack ?? "")
		.split("\n")
		.filter((line) => line.trim().startsWith("at "))
		.slice(0, STACK_FRAMES);
	return [`${reason.name}: ${reason.message}`, ...frames.map((line) => `    ${line.trim()}`)].join("\n");
}
