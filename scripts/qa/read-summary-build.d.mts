export function sha256(path: string): string;
export function buildReadBinaries(
	directory: string,
	baselineRoot: string,
	ceiling: number,
): {
	readonly binary: { readonly path: string; readonly sha256: string; readonly bytes: number };
	readonly [key: string]: unknown;
};
