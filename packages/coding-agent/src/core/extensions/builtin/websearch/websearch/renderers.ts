import { Text } from "@earendil-works/pi-tui";

import { providerEntryLabel } from "./search.ts";
import type { SearchDetails, SearchErrorDetails, SearchProgressDetails, SearchRenderDetails } from "./types.ts";

interface ThemeLike {
	bold(value: string): string;
	fg(key: string, value: string): string;
}

interface SearchArgs {
	query: string;
	allowed_domains?: string[];
	blocked_domains?: string[];
}

interface ResultLike<TDetails> {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: TDetails;
}

interface RenderResultOptions {
	expanded?: boolean;
	isPartial?: boolean;
}

function shorten(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function durationText(durationMs: number): string {
	return durationMs >= 1000 ? `${Math.round(durationMs / 1000)}s` : `${durationMs}ms`;
}

function attemptLabel(attempts: SearchDetails["attempts"]): string {
	return attempts
		? attempts
				.map((attempt) => `${providerEntryLabel(attempt)}:${attempt.error ? "failed" : attempt.resultsCount}`)
				.join(" -> ")
		: "";
}

function routeStateLabel(details: SearchProgressDetails): string {
	const labels = details.routeLabels ?? details.providerLabels;
	if (labels.length === 0) return "";
	const attempts = details.attempts ?? [];
	return labels
		.map((label, index) => {
			const attempt = attempts[index];
			if (attempt) return `${label}:${attempt.error ? "failed" : attempt.resultsCount}`;
			return `${label}:${index === attempts.length ? "searching" : "pending"}`;
		})
		.join(" -> ");
}

function isSearchProgressDetails(details: SearchRenderDetails | undefined): details is SearchProgressDetails {
	return details !== undefined && "phase" in details && details.phase === "searching";
}

function isSearchErrorDetails(details: SearchRenderDetails): details is SearchErrorDetails {
	return "phase" in details && details.phase === "error";
}

export function renderSearchCall(args: SearchArgs, theme: ThemeLike): Text {
	const head = theme.fg("toolTitle", theme.bold("web_search "));
	const query = theme.fg("accent", `"${shorten(args.query, 90)}"`);
	const domains = args.allowed_domains ?? args.blocked_domains;
	const filter = domains?.length ? theme.fg("muted", ` domains:${domains.length}`) : "";
	return new Text(head + query + filter, 0, 0);
}

export function renderSearchResult(
	result: ResultLike<SearchRenderDetails>,
	options: RenderResultOptions,
	theme: ThemeLike,
): Text {
	if (options.isPartial) {
		const details = result.details;
		if (isSearchProgressDetails(details)) {
			if (details.currentProvider) {
				const line = theme.fg(
					"warning",
					`Searching "${shorten(details.query, 80)}" via ${details.currentProvider}`,
				);
				const route = routeStateLabel(details);
				const rows = options.expanded && route ? [line, theme.fg("muted", `route ${route}`)] : [line];
				return new Text(rows.join("\n"), 0, 0);
			}
			const route = details.providerLabels.length > 0 ? details.providerLabels.join(" -> ") : "configured providers";
			return new Text(theme.fg("warning", `Searching "${shorten(details.query, 80)}" via ${route}`), 0, 0);
		}
		return new Text(theme.fg("warning", result.content[0]?.text ?? "Searching the web..."), 0, 0);
	}

	const details = result.details;
	if (!details) return new Text(theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
	if (isSearchProgressDetails(details)) return new Text(theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
	if (isSearchErrorDetails(details)) return new Text(theme.fg("error", details.error), 0, 0);
	if (details.error) return new Text(theme.fg("error", details.error), 0, 0);

	const count = details.results.length;
	const provider = providerEntryLabel(details);
	const summary =
		theme.fg("success", `${count} result${count === 1 ? "" : "s"}`) +
		theme.fg("muted", ` via ${provider} in ${durationText(details.durationMs)}`) +
		(details.truncated ? theme.fg("warning", " (truncated)") : "");

	if (count === 0) return new Text(summary, 0, 0);

	const attempts = attemptLabel(details.attempts);
	const rows = options.expanded && attempts ? [summary, theme.fg("muted", `route ${attempts}`)] : [summary];
	const visibleLimit = options.expanded ? 8 : 3;
	for (const item of details.results.slice(0, visibleLimit)) {
		rows.push(`${theme.fg("accent", shorten(item.title, 80))} ${theme.fg("dim", shorten(item.url, 100))}`);
		if (item.snippet) rows.push(theme.fg("muted", `  ${shorten(item.snippet, 140)}`));
	}
	if (details.results.length > visibleLimit) {
		rows.push(theme.fg("dim", `… ${details.results.length - visibleLimit} more sources`));
	}
	return new Text(rows.join("\n"), 0, 0);
}
