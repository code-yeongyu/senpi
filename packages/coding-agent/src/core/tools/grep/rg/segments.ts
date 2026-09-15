import type { GrepEngineRequest, GrepEngineResult } from "../engine.ts";
import { segmentFlags } from "./args.ts";
import type { Candidate } from "./enumerate.ts";
import { collectSegmentRows, type FileRows } from "./json-rows.ts";
import { pathOrder } from "./paths.ts";
import { MAX_FILE_BYTES, readSearchablePrefix } from "./prefix-pass.ts";
import type { RgRun } from "./process.ts";

const CAPPED_BATCH_SIZE = 200;

function planSegments(ordered: Candidate[], request: GrepEngineRequest): Candidate[][] {
	const segments: Candidate[][] = [];
	for (const candidate of ordered) {
		const previous = segments.at(-1);
		if (
			!candidate.binary &&
			candidate.size <= MAX_FILE_BYTES &&
			previous &&
			!previous[0].binary &&
			previous[0].size <= MAX_FILE_BYTES &&
			previous[0].root === candidate.root &&
			(request.maxCount === undefined || previous.length < CAPPED_BATCH_SIZE)
		)
			previous.push(candidate);
		else segments.push([candidate]);
	}
	return segments;
}

function admitFiles(
	files: Map<string, FileRows>,
	request: GrepEngineRequest,
	result: GrepEngineResult,
): Candidate | undefined {
	let lastCommitted: Candidate | undefined;
	const segmentFiles = [...files.values()].sort((a, b) => pathOrder(a.candidate.display, b.candidate.display));
	for (const file of segmentFiles) {
		const rows = [...file.rows.values()].sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
		const matching = rows.filter((row) => !row.isContext);
		if (matching.length === 0) continue;
		const perFileCap = request.maxCountPerFile ?? Infinity;
		const perFileLimited = request.mode !== "files" && matching.length > perFileCap;
		result.perFileLimitReached ||= perFileLimited;
		const remaining = Math.max(
			0,
			(request.maxCount ?? Infinity) -
				(request.mode === "files" ? result.counts.files : (result.counts.matches ?? 0)),
		);
		const admitted = matching.slice(
			0,
			request.mode === "files" ? (remaining > 0 ? 1 : 0) : Math.min(perFileCap, remaining),
		);
		const available = request.mode === "files" ? 1 : Math.min(matching.length, perFileCap);
		if (admitted.length < available) result.limitReached = true;
		if (admitted.length === 0) continue;
		lastCommitted = file.candidate;
		result.counts.files++;
		if (result.counts.matches !== null) result.counts.matches += admitted.length;
		if (request.mode === "count" || request.mode === "files")
			result.fileCounts.push({
				path: file.candidate.display,
				count: request.mode === "files" ? null : admitted.length,
				limitReached: perFileLimited,
			});
		else {
			const lines = new Set(admitted.map((row) => row.line));
			for (const row of rows) {
				if (
					lines.has(row.line) ||
					(row.isContext &&
						admitted.some(
							(match) =>
								row.line >= match.line - (request.contextBefore ?? 0) &&
								row.line <= match.line + (request.contextAfter ?? 0),
						))
				)
					result.matches.push(row);
			}
		}
	}
	return lastCommitted;
}

export async function searchSegments({
	candidates,
	request,
	walk,
	matcher,
	run,
	check,
	result,
}: {
	candidates: Candidate[];
	request: GrepEngineRequest;
	walk: string[];
	matcher: string[];
	run: RgRun;
	check: () => void;
	result: GrepEngineResult;
}): Promise<void> {
	const segments = planSegments(candidates, request);
	let matcherRan = false;
	for (const [segmentIndex, segment] of segments.entries()) {
		check();
		const first = segment[0];
		if (first.binary) {
			result.filesSearched = first.ordinal;
			continue;
		}
		const oversized = first.size > MAX_FILE_BYTES;
		const prefix = oversized ? await readSearchablePrefix(first, result, check) : undefined;
		if (oversized && prefix === undefined) {
			result.filesSearched = first.ordinal;
			continue;
		}

		const { files, segmentBinary, onEvent } = collectSegmentRows(segment, request, oversized);
		matcherRan = true;
		if (oversized) await run([...matcher, "--", request.pattern], request.cwd, onEvent, prefix);
		else await run(segmentFlags(segment, request.pattern, walk, matcher), first.root.cwd, onEvent);
		check();
		// Nothing from a partially completed segment is visible before this point.
		if (oversized) result.prefixSearched++;
		result.skippedBinary += segmentBinary.size;
		const lastCommitted = admitFiles(files, request, result);
		result.filesSearched = segment[segment.length - 1].ordinal;
		const admittedCount = request.mode === "files" ? result.counts.files : (result.counts.matches ?? 0);
		if (request.maxCount !== undefined && admittedCount >= request.maxCount) {
			// A segment may have searched beyond the cap; only the admitted prefix counts.
			if (lastCommitted) result.filesSearched = lastCommitted.ordinal;
			if (segmentIndex < segments.length - 1) result.limitReached = true;
			break;
		}
	}
	// An empty/all-skipped corpus must still report a malformed matcher, not a false no-match.
	if (!matcherRan) await run([...matcher, "--", request.pattern], request.cwd, () => {}, Buffer.alloc(0));
}
