/**
 * Splits text read from the process kernel's fd 1 pipe into the output it carries and the result keys its drain
 * markers name, in order. A read boundary can cut a marker, so a trailing prefix of one is handed back as `carry` for
 * the next read rather than sent as output.
 *
 * Self-contained on purpose: its source also runs inside the pipe reader thread (process-entry.js `DRAINER`).
 */
export function scanDrainText(carry, chunk, marker) {
	let text = carry + chunk;
	const parts = [];
	for (;;) {
		const at = text.indexOf(marker);
		if (at === -1) break;
		const close = text.indexOf("\u0000", at + marker.length);
		if (close === -1) break;
		if (at > 0) parts.push({ text: text.slice(0, at) });
		parts.push({ key: text.slice(at + marker.length, close) });
		text = text.slice(close + 1);
	}
	let nextCarry = "";
	const partial = text.lastIndexOf("\u0000");
	if (partial !== -1 && marker.startsWith(text.slice(partial, partial + marker.length))) {
		nextCarry = text.slice(partial);
		text = text.slice(0, partial);
	}
	if (text.length > 0) parts.push({ text });
	return { parts, carry: nextCarry };
}
