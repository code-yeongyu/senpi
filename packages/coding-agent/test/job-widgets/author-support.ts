import {
	type JobWidgetAuthor,
	type JobWidgetAuthoringSource,
	type JobWidgetAuthorRequest,
	type JobWidgetBrief,
	type JobWidgetObfuscator,
	JobWidgetRequestController,
	type JobWidgetRequestJob,
	type JobWidgetRequestLimits,
	type JobWidgetSourceSample,
	type JobWidgetSpec,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { RegExpLineMatcher, START } from "./support.ts";

export const RPS_SPEC = {
	title: "load test",
	rules: [{ from: "out", match: String.raw`rps=(?P<rps>\d+)` }],
	blocks: [{ kind: "spark", field: "rps", label: "req/s" }],
};

/** Parses, but matches none of the sample lines: the dry run rejects it. */
export const UNMATCHED_SPEC = {
	title: "load test",
	rules: [{ from: "out", match: String.raw`qps=(?P<qps>\d+)` }],
	blocks: [{ kind: "spark", field: "qps", label: "q/s" }],
};

export const RPS_LINES = ["req 1 rps=40", "req 2 rps=44", "req 3 rps=51"];

export function outSample(lines: readonly string[], id = "out", label = id): JobWidgetSourceSample {
	return { id, label, size: lines.join("\n").length, lines: lines.length, head: [...lines], tail: [] };
}

export class FakeJob implements JobWidgetRequestJob, JobWidgetAuthoringSource {
	readonly id: string;
	readonly startTime: number;
	brief: JobWidgetBrief;
	sources: JobWidgetSourceSample[];
	spec: JobWidgetSpec | undefined;
	unmatchedLines = 0;
	lastMatchAt: number | undefined;

	constructor(id: string, brief: JobWidgetBrief = { kind: "bash", command: "./bench.sh" }, lines = RPS_LINES) {
		this.id = id;
		this.startTime = START;
		this.brief = brief;
		this.sources = [outSample(lines)];
	}

	get runtime(): JobWidgetAuthoringSource {
		return this;
	}

	samples(): JobWidgetSourceSample[] {
		return this.sources;
	}
}

export function scriptedAuthor(...answers: unknown[]) {
	const requests: JobWidgetAuthorRequest[] = [];
	const author: JobWidgetAuthor = async (request) => {
		requests.push(request);
		return answers.shift();
	};
	return { author, requests };
}

export function controllerFor(
	author: JobWidgetAuthor,
	limits: Partial<JobWidgetRequestLimits> = {},
	obfuscate?: JobWidgetObfuscator,
) {
	let now = START + 15_000;
	const controller = new JobWidgetRequestController({
		author,
		matcher: new RegExpLineMatcher(),
		now: () => now,
		limits,
		obfuscate,
	});
	return {
		controller,
		advance(ms: number): void {
			now += ms;
		},
		get now(): number {
			return now;
		},
	};
}
