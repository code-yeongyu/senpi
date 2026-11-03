/**
 * Secrets never reach a widget author: the request controller passes every request through
 * {@link redactAuthorRequest} before any author (model-backed or host-injected) sees it, and before
 * the sample builder budgets or cuts a byte of it. The author only needs line shapes, never values.
 *
 * Redaction is stateful per source: a private key spans lines, so each source's lines (and each
 * multi-line text) go through one redactor in order, never a fresh one per line.
 */
import { redactSecrets } from "../../../sensitive-output.ts";
import { SecretOutputRedactor } from "../../../tools/secret-output-redactor.ts";
import type { JobWidgetAuthorRequest, JobWidgetBrief } from "./author-types.ts";
import { PrivateKeyLineFilter } from "./key-block-redact.ts";
import type { JobWidgetSourceSample } from "./source-stats.ts";

export type JobWidgetRedact = (text: string) => string;

/** A stateful redactor for one stream of text: `push` may hold text back until a later push or `finish`. */
export interface JobWidgetStreamRedactor {
	push(text: string): string;
	finish(): string;
}

/** The session's secret obfuscation: a fresh stream redactor for each source, fed that source in order. */
export type JobWidgetObfuscator = () => JobWidgetStreamRedactor;

/** A session obfuscator backed by the bash tool's streaming redactor, for sessions that turn it on. */
export const secretOutputObfuscator: JobWidgetObfuscator = () => new SecretOutputRedactor();

/**
 * One source's lines, redacted in order: the built-in private-key rule first (it applies even with
 * secret handling off), then the session's obfuscator, then `redactSecrets` per line, which runs
 * `redactSensitiveOutput` (environment assignments, `Authorization: Bearer`) before the value-based
 * credential scan (key prefixes such as `ghp_`/`sk-`/`AKIA`, JWTs, bearer tokens, secret-named values).
 * A key block leaves one line, so the lines out are not the lines in.
 */
class JobWidgetSourceRedactor {
	readonly #keys = new PrivateKeyLineFilter();
	readonly #obfuscator: JobWidgetObfuscator | undefined;
	#stream: JobWidgetStreamRedactor | undefined;
	#partial = "";

	constructor(obfuscator?: JobWidgetObfuscator) {
		this.#obfuscator = obfuscator;
	}

	push(line: string): string[] {
		return this.#obfuscate(this.#keys.push(line));
	}

	/** The source skipped text here; see {@link PrivateKeyLineFilter.cut}. */
	cut(): string[] {
		return this.#obfuscate(this.#keys.cut());
	}

	/** The source ended: releases held text. The redactor then starts over as for a new source. */
	finish(): string[] {
		const out = this.#obfuscate(this.#keys.finish());
		if (this.#stream) {
			this.#partial += this.#stream.finish();
			this.#stream = undefined;
		}
		if (this.#partial.length > 0) out.push(redactSecrets(this.#partial));
		this.#partial = "";
		return out;
	}

	#obfuscate(lines: readonly string[]): string[] {
		if (!this.#obfuscator) return lines.map((line) => redactSecrets(line));
		if (lines.length === 0) return [];
		this.#stream ??= this.#obfuscator();
		const stream = this.#stream;
		const out: string[] = [];
		for (const line of lines) {
			const parts = (this.#partial + stream.push(`${line}\n`)).split("\n");
			this.#partial = parts.pop() ?? "";
			for (const part of parts) out.push(redactSecrets(part));
		}
		return out;
	}
}

export interface JobWidgetRedactor {
	/** One whole text (a label, a brief field, retry text), redacted as a source of its own. */
	readonly text: JobWidgetRedact;
	/** A redactor for one source's lines; see {@link JobWidgetSourceRedactor}. */
	source(): JobWidgetSourceRedactor;
}

export function createWidgetRedactor(obfuscate?: JobWidgetObfuscator): JobWidgetRedactor {
	const source = (): JobWidgetSourceRedactor => new JobWidgetSourceRedactor(obfuscate);
	return {
		source,
		text: (text) => {
			const lines = source();
			const out = text.split("\n").flatMap((line) => lines.push(line));
			// A pattern may span a line break (`Authorization:` then the token on the next line).
			return redactSecrets([...out, ...lines.finish()].join("\n"));
		},
	};
}

function redactOptional(text: string | undefined, redact: JobWidgetRedact): string | undefined {
	return text === undefined ? undefined : redact(text);
}

function redactBrief(brief: JobWidgetBrief, redact: JobWidgetRedact): JobWidgetBrief {
	return {
		kind: brief.kind,
		command: redactOptional(brief.command, redact),
		task: redactOptional(brief.task, redact),
		intent: redactOptional(brief.intent, redact),
		watch: redactOptional(brief.watch, redact),
		stage: redactOptional(brief.stage, redact),
	};
}

/**
 * Head then tail through one source redactor. The sample has a cut after the head (the unread
 * middle) and after the tail (output still coming), and either cut can fall inside a key.
 */
function redactSource(source: JobWidgetSourceSample, redactor: JobWidgetRedactor): JobWidgetSourceSample {
	const lines = redactor.source();
	const head = [...source.head.flatMap((line) => lines.push(line)), ...lines.cut()];
	const tail = [...source.tail.flatMap((line) => lines.push(line)), ...lines.cut(), ...lines.finish()];
	return {
		id: source.id,
		label: redactor.text(source.label),
		size: source.size,
		lines: source.lines,
		head,
		tail,
	};
}

/** Every text field of `request` redacted: brief fields, source labels and lines, and retry text. */
export function redactAuthorRequest(
	request: JobWidgetAuthorRequest,
	redactor: JobWidgetRedactor,
): JobWidgetAuthorRequest {
	const redact = redactor.text;
	return {
		jobId: request.jobId,
		brief: redactBrief(request.brief, redact),
		sources: request.sources.map((source) => redactSource(source, redactor)),
		previous: request.previous && { spec: request.previous.spec, reason: redact(request.previous.reason) },
		rejected: request.rejected && {
			answer: redact(request.rejected.answer),
			errors: request.rejected.errors.map(redact),
		},
	};
}
