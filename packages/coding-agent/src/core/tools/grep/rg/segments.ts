import type { GrepEngineRequest, GrepEngineResult } from "../engine.ts";
import { argumentCost, segmentFlags } from "./args.ts";
import { argvBudget, roomAfter } from "./argv.ts";
import type { Candidate } from "./enumerate.ts";
import { collectSegmentRows, type FileRows } from "./json-rows.ts";
import { pathOrder } from "./paths.ts";
import { MAX_FILE_BYTES, readSearchablePrefix } from "./prefix-pass.ts";
import type { RgRun } from "./process.ts";

const CAPPED_BATCH_SIZE = 200;
const MAX_CAPPED_BATCH_SIZE = 1600;

// A capped segment may grow to the ordered prefix already planned: launches grow
// logarithmically while the work searched past the cap stays at most double.
function cappedLimit(head: Candidate): number {
	return Math.min(MAX_CAPPED_BATCH_SIZE, Math.max(CAPPED_BATCH_SIZE, head.ordinal - 1));
}

function joins(previous: Candidate[], candidate: Candidate, request: GrepEngineRequest): boolean {
	const head = previous[0];
	if (head.size > MAX_FILE_BYTES || candidate.size > MAX_FILE_BYTES) return false;
	// Explicit files from any root share one rg launch; binary members stay out of its argv.
	if (head.root.file && candidate.root.file)
		return request.maxCount === undefined || previous.length < cappedLimit(head);
	return (
		!head.binary &&
		!candidate.binary &&
		head.root === candidate.root &&
		(request.maxCount === undefined || previous.length < cappedLimit(head))
	);
}

export interface SegmentPlan {
	walk: string[];
	matcher: string[];
	budget?: number | undefined;
	platform?: NodeJS.Platform;
}

/** Orders candidates into rg launches whose whole command line, fixed arguments included, fits the argv budget. */
export function planSegments(ordered: Candidate[], request: GrepEngineRequest, plan: SegmentPlan): Candidate[][] {
	const platform = plan.platform ?? process.platform;
	const budget = plan.budget ?? argvBudget(platform);
	const segments: Candidate[][] = [];
	let room = 0;
	for (const candidate of ordered) {
		const previous = segments.at(-1);
		const cost = candidate.binary ? 0 : argumentCost(candidate, platform);
		if (previous && joins(previous, candidate, request) && cost <= room) {
			previous.push(candidate);
			room -= cost;
		} else {
			segments.push([candidate]);
			room = roomAfter(segmentFlags([candidate], request.pattern, plan.walk, plan.matcher), budget, platform);
		}
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
	budget,
}: {
	candidates: Candidate[];
	request: GrepEngineRequest;
	walk: string[];
	matcher: string[];
	run: RgRun;
	check: () => void;
	result: GrepEngineResult;
	budget?: number | undefined;
}): Promise<void> {
	const segments = planSegments(candidates, request, { walk, matcher, budget });
	let matcherRan = false;
	for (const [segmentIndex, segment] of segments.entries()) {
		check();
		const searchable = segment.filter((candidate) => !candidate.binary);
		if (searchable.length === 0) {
			result.filesSearched = segment[segment.length - 1].ordinal;
			continue;
		}
		const first = searchable[0];
		const oversized = first.size > MAX_FILE_BYTES;
		const prefix = oversized ? await readSearchablePrefix(first, result, check) : undefined;
		if (oversized && prefix === undefined) {
			result.filesSearched = first.ordinal;
			continue;
		}

		const { files, segmentBinary, onEvent } = collectSegmentRows(searchable, request, oversized);
		matcherRan = true;
		if (oversized) await run([...matcher, "--", request.pattern], request.cwd, onEvent, prefix);
		else await run(segmentFlags(searchable, request.pattern, walk, matcher), first.root.cwd, onEvent);
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
