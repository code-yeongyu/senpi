import { resolve } from "node:path";
import { readIterations } from "../../../tui/bench/_meta.ts";

export type ResumeBenchArgs = {
	readonly messages: number;
	readonly iterations: number;
	readonly jsonPath: string | undefined;
};

function parsePositiveInt(raw: string | undefined, flag: string): number {
	const parsed = raw === undefined ? Number.NaN : Number(raw);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`Invalid ${flag}: ${raw ?? "(missing)"}`);
	}
	return Math.floor(parsed);
}

export function parseResumeBenchArgs(argv: readonly string[]): ResumeBenchArgs {
	let messages = 5000;
	let jsonPath: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			throw new Error(
				"Usage: node packages/coding-agent/test/benchmarks/resume-flow.bench.mjs --messages <n> --iterations <n> [--json <path>]",
			);
		}
		if (arg === "--iterations") {
			index++;
			continue;
		}
		if (arg === "--messages") {
			messages = parsePositiveInt(argv[index + 1], "--messages");
			index++;
			continue;
		}
		if (arg === "--json") {
			const rawPath = argv[index + 1];
			if (!rawPath) {
				throw new Error("Missing value for --json");
			}
			jsonPath = resolve(process.cwd(), rawPath);
			index++;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return {
		messages,
		iterations: readIterations(15),
		jsonPath,
	};
}
