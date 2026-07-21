export type FuzzyFileSearchMatchType = "file" | "directory";

export type FuzzyFileSearchResult = {
	readonly root: string;
	readonly path: string;
	readonly match_type: FuzzyFileSearchMatchType;
	readonly file_name: string;
	readonly score: number;
	readonly indices: readonly number[] | null;
};

export type FuzzyFileSearchParams = {
	readonly query: string;
	readonly roots: readonly string[];
	readonly cancellationToken: string | null;
};
export type FuzzyFileSearchResponse = { readonly files: readonly FuzzyFileSearchResult[] };

export type FuzzyFileSearchSessionStartParams = {
	readonly sessionId: string;
	readonly roots: readonly string[];
};
export type FuzzyFileSearchSessionStartResponse = Record<string, never>;

export type FuzzyFileSearchSessionUpdateParams = {
	readonly sessionId: string;
	readonly query: string;
};
export type FuzzyFileSearchSessionUpdateResponse = Record<string, never>;

export type FuzzyFileSearchSessionStopParams = { readonly sessionId: string };
export type FuzzyFileSearchSessionStopResponse = Record<string, never>;

export type FuzzyFileSearchSessionUpdatedNotification = {
	readonly sessionId: string;
	readonly query: string;
	readonly files: readonly FuzzyFileSearchResult[];
};
export type FuzzyFileSearchSessionCompletedNotification = { readonly sessionId: string };
