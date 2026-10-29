// EQ fixture extension: tools whose bodies stay in flight until the case releases a fake-server barrier
// (`GET $EQ_BARRIER_ORIGIN/__barrier/<name>`), so a case decides when each body finishes. Loaded unmodified by path.
//
// - eq_read  {path, barrier}: parallel; after the barrier, returns the file's text (no effect).
// - eq_write {path, text, barrier}: parallel; after the barrier, writes the file (an O5 effect).
// - eq_seq   {path, text, barrier}: executionMode "sequential"; otherwise eq_write.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

async function hold(barrier, signal) {
	const response = await fetch(`${process.env.EQ_BARRIER_ORIGIN}/__barrier/${encodeURIComponent(barrier)}`, {
		signal,
	});
	await response.text();
}

const text = (value) => ({ content: [{ type: "text", text: value }], details: {} });

function writer(name, label, executionMode) {
	return {
		name,
		label,
		description: `EQ fixture: after barrier <barrier>, write <text> to <path>${executionMode ? " (sequential)" : ""}.`,
		parameters: Type.Object({ path: Type.String(), text: Type.String(), barrier: Type.String() }),
		...(executionMode ? { executionMode } : {}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await hold(params.barrier, signal);
			await writeFile(resolve(ctx.cwd, params.path), params.text);
			return text(`${name} wrote ${params.path}`);
		},
	};
}

export default function heldTools(pi) {
	pi.registerTool({
		name: "eq_read",
		label: "EQ read",
		description: "EQ fixture: after barrier <barrier>, read <path>.",
		parameters: Type.Object({ path: Type.String(), barrier: Type.String() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await hold(params.barrier, signal);
			return text(await readFile(resolve(ctx.cwd, params.path), "utf8"));
		},
	});
	pi.registerTool(writer("eq_write", "EQ write"));
	pi.registerTool(writer("eq_seq", "EQ sequential write", "sequential"));
}
