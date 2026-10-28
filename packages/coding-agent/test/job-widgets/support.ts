import { beforeEach, describe } from "vitest";

import {
	type CompiledLineMatcher,
	defaultLineMatcher,
	type JobTextChunk,
	type JobTextSource,
	type JobWidgetBlock,
	type JobWidgetDerivation,
	JobWidgetRuntime,
	type JobWidgetSampleLines,
	type JobWidgetSpec,
	type JobWidgetViewContext,
	type LineMatch,
	type LineMatcher,
	MatcherCompileError,
	patternGroupNames,
	validateJobWidgetSpec,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";

/**
 * Test-only engine: JS RegExp backtracks, so it never ships as the production matcher. It keeps
 * the port's contract (leftmost match per pattern per line, named-group spans, typed errors).
 */
export class RegExpLineMatcher implements LineMatcher {
	readonly compiled: string[][] = [];

	compile(patterns: readonly string[]): CompiledLineMatcher {
		this.compiled.push([...patterns]);
		const expressions = patterns.map((pattern, index) => {
			try {
				return new RegExp(pattern, "d");
			} catch (error) {
				throw new MatcherCompileError(index, error instanceof Error ? error.message : String(error));
			}
		});
		const groupNames = patterns.map((pattern) => patternGroupNames(pattern));
		return {
			groupNames,
			matchLines(lines: readonly string[]): LineMatch[] {
				const matches: LineMatch[] = [];
				lines.forEach((line, lineIndex) => {
					expressions.forEach((expression, pattern) => {
						const found = expression.exec(line);
						if (!found) return;
						const spans = groupNames[pattern].map((name) => {
							const span = found.indices?.groups?.[name];
							return span ? { start: span[0], end: span[1] } : undefined;
						});
						matches.push({ line: lineIndex, pattern, spans });
					});
				});
				return matches;
			},
		};
	}
}

/** Every engine the P1 tables run on: the shipped RE2 matcher and the RegExp fake. */
export const LINE_MATCHERS: readonly [string, () => LineMatcher][] = [
	["re2", () => defaultLineMatcher],
	["RegExp fake", () => new RegExpLineMatcher()],
];

let activeMatcher = LINE_MATCHERS[0][1];

/** The engine of the running {@link describeEachMatcher} pass; `validSpec` and `harness` use it. */
export function lineMatcher(): LineMatcher {
	return activeMatcher();
}

/** Declares `body`'s tests once per engine in {@link LINE_MATCHERS}. */
export function describeEachMatcher(name: string, body: () => void): void {
	describe.each(LINE_MATCHERS)(`${name} (%s)`, (_engine, make) => {
		beforeEach(() => {
			activeMatcher = make;
		});
		body();
	});
}

/** A source whose retained text and dropped prefix the test controls. */
export class ScriptedSource implements JobTextSource {
	readonly id: string;
	readonly label: string;
	open = true;
	#text = "";
	#dropped = 0;

	constructor(id: string, label = id) {
		this.id = id;
		this.label = label;
	}

	append(text: string): void {
		this.#text += text;
	}

	/** Forgets retained units up to the end of `marker`, as a bounded tap does. */
	dropThrough(marker: string): void {
		const count = this.#text.lastIndexOf(marker) + marker.length;
		this.#dropped += count;
		this.#text = this.#text.slice(count);
	}

	read(from: number): JobTextChunk {
		const start = Math.max(from, this.#dropped);
		return {
			start,
			end: this.#dropped + this.#text.length,
			text: this.#text.slice(start - this.#dropped),
			open: this.open,
		};
	}
}

export const START = 1_000_000;

export function validSpec(value: unknown, samples?: readonly JobWidgetSampleLines[], brief?: string): JobWidgetSpec {
	const checked = validateJobWidgetSpec(value, { matcher: lineMatcher(), samples, brief });
	if (!checked.ok) throw new Error(checked.errors.join("\n"));
	return checked.spec;
}

export function harness(spec: JobWidgetSpec | undefined, ...sources: ScriptedSource[]) {
	let now = START;
	const runtime = new JobWidgetRuntime({ spec, matcher: lineMatcher(), startTime: START, now: () => now });
	return {
		runtime,
		advance(ms: number): void {
			now += ms;
		},
		ingest(flush = false): void {
			runtime.ingest(sources, flush);
		},
		derive(context: Partial<JobWidgetViewContext> = {}): JobWidgetDerivation {
			return runtime.derive({ label: "bench job", lineStage: true, authoring: false, ...context });
		},
	};
}

export function block<K extends JobWidgetBlock["kind"]>(
	derivation: JobWidgetDerivation,
	kind: K,
): Extract<JobWidgetBlock, { kind: K }> {
	for (const candidate of derivation.view.blocks) {
		if (isKind(candidate, kind)) return candidate;
	}
	throw new Error(`no ${kind} block in ${JSON.stringify(derivation.view)}`);
}

function isKind<K extends JobWidgetBlock["kind"]>(
	candidate: JobWidgetBlock,
	kind: K,
): candidate is Extract<JobWidgetBlock, { kind: K }> {
	return candidate.kind === kind;
}
