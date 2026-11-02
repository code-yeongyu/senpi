export const READ_FOLD_SETTINGS = Object.freeze({
	minBodyLines: 4,
	minCommentLines: 6,
	minTotalLines: 100,
	unfoldUntil: 50,
	unfoldLimit: 100,
} as const);

/** Internal policy constants, not a user-configurable settings surface. */
export type ReadFoldSettings = typeof READ_FOLD_SETTINGS;
export type ReadLineRange = { readonly startLine: number; readonly endLine: number };
export type ReadBraceScan =
	| { readonly status: "parsed"; readonly ranges: readonly ReadLineRange[] }
	| { readonly status: "parse_failure"; readonly reason: string };
/** Inclusive, 1-based omitted interiors. Children exclude their parent's boundary lines. */
export type ReadFoldRange = ReadLineRange & { readonly children: readonly ReadFoldRange[] };
export type ReadFolderInput = {
	readonly path: string;
	readonly text: string;
	readonly settings: ReadFoldSettings;
};
export type ReadFolderResult =
	| { readonly status: "parsed"; readonly text: string; readonly ranges: readonly ReadFoldRange[] }
	| { readonly status: "unsupported"; readonly reason: "unsupported_language" | "prose_exempt" }
	| { readonly status: "parse_failure"; readonly reason: string };

/** Synchronous and pure. I/O, cancellation and unexpected exceptions belong to the caller. */
export interface ReadFolder {
	readonly id: string;
	readonly version: string;
	fold(input: ReadFolderInput): ReadFolderResult;
}
