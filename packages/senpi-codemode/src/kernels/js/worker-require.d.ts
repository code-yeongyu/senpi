export interface CellRequireContext {
	readonly cwdUrl: string;
	readonly packageRootUrl?: string | null;
}

export interface CellResolve {
	(specifier: string, options?: { readonly paths?: readonly string[] }): string;
	paths(specifier: string): string[] | null;
}

export interface CellRequire {
	(specifier: string): unknown;
	readonly resolve: CellResolve;
	readonly cache: Record<string, unknown>;
}

export function createCellRequire(context: () => CellRequireContext): CellRequire;

export { createRequire } from "node:module";
