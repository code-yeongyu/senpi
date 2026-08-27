import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvalDetachedCellNotification, EvalDetachedCellSnapshot } from "./detached-cell-manager.ts";

const NOTIFICATION_TAIL_BYTES = 512;

export function detachedNotificationSpillPath(artifactsDir: string | undefined, cellId: string): string | undefined {
	if (artifactsDir === undefined) return undefined;
	return join(artifactsDir, "local", `detached-eval-${safeCellId(cellId)}.log`);
}

export async function buildDetachedCellNotification(
	snapshot: EvalDetachedCellSnapshot,
	spillPath: string | undefined,
): Promise<EvalDetachedCellNotification> {
	const body = notificationBody(snapshot);
	const overflow = Buffer.byteLength(body, "utf8") > NOTIFICATION_TAIL_BYTES;
	let spillNotice = "";
	if (overflow && spillPath !== undefined) {
		try {
			await mkdir(dirname(spillPath), { recursive: true });
			await writeFile(spillPath, body, "utf8");
			// The agent read tool resolves plain paths only, so the notice must carry
			// the absolute spill path, never the kernel-helper local:// scheme.
			spillNotice = `\nBuffered output overflowed; full output: ${spillPath}`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			spillNotice = `\nBuffered output overflow could not be spilled: ${message}`;
		}
	}
	return {
		cellId: snapshot.cellId,
		content: `${overflow ? notificationPreview(snapshot) : body}${overflow ? "\n[…notification tail capped…]" : ""}${spillNotice}`,
	};
}

function notificationBody(cell: EvalDetachedCellSnapshot): string {
	const outcome = outcomeOf(cell);
	const resultText = textContent(cell);
	const stateNote = stateNoteOf(cell);
	return [
		`<system-reminder>Detached eval cell ${cell.cellId} (${cell.language}) ${outcome}.`,
		resultText.length === 0 ? "(no output)" : resultText,
		`${stateNote}</system-reminder>`,
	].join("\n");
}

function notificationPreview(cell: EvalDetachedCellSnapshot): string {
	const outcome = outcomeOf(cell);
	const resultText = textContent(cell);
	const stateNote = stateNoteOf(cell);
	return [
		`<system-reminder>Detached eval cell ${cell.cellId} (${cell.language}) ${outcome}.`,
		"Buffered output tail:",
		truncateTailUtf8(resultText, NOTIFICATION_TAIL_BYTES),
		`${stateNote}</system-reminder>`,
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
	if (cell.state === "completed") return "completed";
	if (cell.state === "cancelled") return "cancelled";
	return "failed";
}

function stateNoteOf(cell: EvalDetachedCellSnapshot): string {
	if (cell.state === "cancelled" && cell.language === "js")
		return "JavaScript worker was restarted; VM state was lost.";
	if (cell.state === "cancelled" && cell.language === "py")
		return "Python kernel was interrupted; its existing variables are preserved.";
	return "Kernel state updated - variables are available to the next eval cell.";
}

function safeCellId(cellId: string): string {
	return cellId.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function truncateTailUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}
