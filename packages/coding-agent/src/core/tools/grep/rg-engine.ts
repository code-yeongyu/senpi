import { spawn } from "node:child_process";
import { ensureTool } from "../../../utils/tools-manager.ts";
import { type GrepEngine, GrepEngineError, type GrepEngineRequest, type GrepEngineResult } from "./engine.ts";
import { matcherFlags, walkerFlags } from "./rg/args.ts";
import { enumerateCandidates, resolveRoots } from "./rg/enumerate.ts";
import { createRgRunner, type RgEngineOptions, SearchTimeout } from "./rg/process.ts";
import { searchSegments } from "./rg/segments.ts";

export type { RgEngineOptions } from "./rg/process.ts";

/** A recursive rg walk per ordered segment, never a second implementation of ignore rules. */
export class RgGrepEngine implements GrepEngine {
	readonly name = "rg" as const;
	private readonly launch: NonNullable<RgEngineOptions["spawn"]>;
	private readonly now: () => number;

	constructor(options: RgEngineOptions = {}) {
		this.launch = options.spawn ?? spawn;
		this.now = options.now ?? Date.now;
	}

	async search(request: GrepEngineRequest, signal?: AbortSignal): Promise<GrepEngineResult> {
		const started = this.now();
		const deadline = started + (request.timeoutMs ?? 30_000);
		const result: GrepEngineResult = {
			matches: [],
			fileCounts: [],
			counts: { matches: request.mode === "files" ? null : 0, files: 0, exact: true },
			filesSearched: 0,
			limitReached: false,
			perFileLimitReached: false,
			skippedOversized: 0,
			prefixSearched: 0,
			skippedBinary: 0,
			missingPaths: [],
			warnings: [],
			timedOut: false,
			elapsedMs: 0,
			effectivePattern: request.pattern,
			patternKind: request.literal ? "literal" : "regex",
			regexEngine: request.pcre2 ? "pcre2" : "rust",
		};
		const check = () => {
			if (signal?.aborted) throw new GrepEngineError("ABORTED", "Grep search aborted");
			if (this.now() >= deadline) throw new SearchTimeout();
		};
		try {
			check();
			const roots = await resolveRoots(request, result);
			check();
			const executable = await ensureTool("rg");
			if (!executable)
				throw new GrepEngineError("ENGINE_UNAVAILABLE", "ripgrep is unavailable and could not be downloaded");
			const walk = walkerFlags(request);
			const matcher = matcherFlags(request);
			const run = createRgRunner({
				executable,
				launch: (command, args, options) => this.launch(command, args, options),
				now: () => this.now(),
				deadline,
				signal,
				check,
			});
			const candidates = await enumerateCandidates({ roots, cwd: request.cwd, walk, run, check, result });
			await searchSegments({ candidates, request, walk, matcher, run, check, result });
		} catch (error) {
			if (!(error instanceof SearchTimeout)) throw error;
			result.timedOut = true;
			result.warnings.push({
				code: "TIMED_OUT",
				message: `Timed out after ${request.timeoutMs ?? 30_000} ms; showing the completed ordered prefix.`,
			});
		}
		result.counts.exact = !result.limitReached && !result.perFileLimitReached && !result.timedOut;
		result.elapsedMs = Math.max(0, this.now() - started);
		return result;
	}
}

export function createRgEngine(options: RgEngineOptions = {}): GrepEngine {
	return new RgGrepEngine(options);
}
