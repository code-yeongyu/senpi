import { resolve } from "node:path";
import { GrepEngineError, type GrepEngineMatch, type GrepEngineRequest } from "../engine.ts";
import type { Candidate } from "./enumerate.ts";

interface RgText {
	text?: string;
	bytes?: string;
}
export interface RgEvent {
	type: "begin" | "match" | "context" | "end" | "summary";
	data: {
		path?: RgText;
		lines?: RgText;
		line_number?: number;
		submatches?: Array<{ start: number }>;
		binary_offset?: number | null;
	};
}
export interface FileRows {
	candidate: Candidate;
	rows: Map<number, GrepEngineMatch>;
}

export function parseRgEvent(line: string): RgEvent {
	const event = JSON.parse(line) as RgEvent;
	if (!event || !["begin", "match", "context", "end", "summary"].includes(event.type) || !event.data)
		throw new Error("Invalid ripgrep JSON event");
	return event;
}

function decode(value: RgText | undefined): string {
	if (typeof value?.text === "string") return value.text;
	if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
	throw new GrepEngineError("ENGINE_UNAVAILABLE", "Invalid ripgrep JSON text/bytes field");
}

export function collectSegmentRows(segment: Candidate[], request: GrepEngineRequest, oversized: boolean) {
	const first = segment[0];
	const files = new Map<string, FileRows>();
	const byPath = new Map(segment.map((candidate) => [candidate.absolute, candidate]));
	const segmentBinary = new Set<string>();
	const onEvent = (event: RgEvent) => {
		if (event.type === "summary") return;
		const candidate = oversized ? first : byPath.get(resolve(first.root.cwd, decode(event.data.path)));
		if (!candidate) throw new Error("ripgrep searched a file outside the ordered segment");
		if (event.type === "begin") {
			files.set(candidate.display, { candidate, rows: new Map() });
			return;
		}
		if (event.type === "end") {
			if (event.data.binary_offset != null) {
				files.delete(candidate.display);
				segmentBinary.add(candidate.display);
			}
			return;
		}
		const file = files.get(candidate.display);
		if (!file || typeof event.data.line_number !== "number")
			throw new Error("ripgrep match/context without a begin or line number");
		const text = decode(event.data.lines).replace(/\n$/, "").split("\n");
		for (const [index, physical] of text.entries()) {
			const line = event.data.line_number + index;
			if (line < (request.lineStart ?? 1) || line > (request.lineEnd ?? Infinity)) continue;
			const isContext = event.type === "context";
			const existing = file.rows.get(line);
			if (existing && (!existing.isContext || isContext)) continue;
			const column =
				!isContext && index === 0 && event.data.submatches?.[0] ? event.data.submatches[0].start + 1 : undefined;
			let content = physical.replace(/\r$/, "");
			let truncated = false;
			if (request.maxColumns !== undefined) {
				const scalars = Array.from(content);
				if (scalars.length > request.maxColumns) {
					content = `${scalars.slice(0, request.maxColumns).join("")}...`;
					truncated = true;
				}
			}
			file.rows.set(line, { path: candidate.display, line, column, text: content, isContext, truncated });
		}
	};
	return { files, segmentBinary, onEvent };
}
