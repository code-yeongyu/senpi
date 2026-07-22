import type { ProviderNativeContent } from "@earendil-works/pi-ai";
import type { WireItem } from "./turn-log.ts";

type WebSearchAction =
	| { readonly type: "search"; readonly query: string | null; readonly queries: readonly string[] | null }
	| { readonly type: "openPage"; readonly url: string | null }
	| { readonly type: "findInPage"; readonly url: string | null; readonly pattern: string | null }
	| { readonly type: "other" };

export function webSearchItem(id: string, content: ProviderNativeContent): WireItem {
	const action = readAction(content);
	return {
		type: "webSearch",
		id,
		query: actionDetail(action),
		action,
		results: readResults(content),
	};
}

function readResults(content: ProviderNativeContent): readonly unknown[] | null {
	if (!isRecord(content.raw) || !Array.isArray(content.raw.results)) return null;
	return content.raw.results;
}

function readAction(content: ProviderNativeContent): WebSearchAction {
	if (!isRecord(content.raw)) return { type: "other" };
	const rawAction = content.raw.action;
	if (!isRecord(rawAction)) return { type: "other" };
	const type = readString(rawAction.type);
	switch (type) {
		case "search":
			return {
				type,
				query: readNullableString(rawAction.query),
				queries: readNullableStrings(rawAction.queries),
			};
		case "open_page":
		case "openPage":
			return { type: "openPage", url: readNullableString(rawAction.url) };
		case "find_in_page":
		case "findInPage":
			return {
				type: "findInPage",
				url: readNullableString(rawAction.url),
				pattern: readNullableString(rawAction.pattern),
			};
		default:
			return { type: "other" };
	}
}

function actionDetail(action: WebSearchAction): string {
	switch (action.type) {
		case "search": {
			if (action.query) return action.query;
			const first = action.queries?.[0] ?? "";
			return action.queries && action.queries.length > 1 && first ? `${first} ...` : first;
		}
		case "openPage":
			return action.url ?? "";
		case "findInPage":
			if (action.pattern && action.url) return `'${action.pattern}' in ${action.url}`;
			if (action.pattern) return `'${action.pattern}'`;
			return action.url ?? "";
		case "other":
			return "";
		default:
			return assertNeverAction(action);
	}
}

function readNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readNullableStrings(value: unknown): readonly string[] | null {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNeverAction(value: never): never {
	throw new Error(`Unhandled web search action: ${String(value)}`);
}
