/**
 * Secrets never leave the engine in a view: every string of every view (title, stage, headline,
 * labels, bar and grid keys, block text, trend text) is redacted before the state is published,
 * since clients persist the state (the desktop writes it to its event store). The walk covers every
 * string field, so a field added to the contract later is redacted without a change here; only the
 * closed vocabularies below (block kinds, tones) pass through as they are.
 */
import type { JobWidgetRedact } from "./author-redact.ts";
import type { JobWidgetEntry, JobWidgetState } from "./view-types.ts";

const VOCABULARY_KEYS: ReadonlySet<string> = new Set(["kind", "tone"]);

function redactStrings(value: unknown, redact: JobWidgetRedact): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, field]) => [
			key,
			VOCABULARY_KEYS.has(key) ? field : redactStrings(field, redact),
		]),
	);
}

function redactEntry(entry: JobWidgetEntry, redact: JobWidgetRedact): JobWidgetEntry {
	if (entry.view === undefined) return entry;
	// The walk preserves the shape: it maps strings to strings and keeps every other value.
	return { ...entry, view: redactStrings(entry.view, redact) as JobWidgetEntry["view"] };
}

export function redactJobWidgetState(state: JobWidgetState, redact: JobWidgetRedact): JobWidgetState {
	return { ...state, jobs: state.jobs.map((entry) => redactEntry(entry, redact)) };
}
