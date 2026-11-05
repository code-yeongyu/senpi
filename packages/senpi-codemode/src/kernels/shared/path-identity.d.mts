export const PATH_IDENTITY_VERSION: number;

export interface PathIdentityStats {
	readonly dev: bigint;
	readonly ino: bigint;
	isSymbolicLink(): boolean;
}

export interface PathIdentityPrimitives {
	readonly realpathNative: (value: string) => string;
	readonly lstat: (value: string, options?: { bigint: true }) => PathIdentityStats;
	readonly readlink: (value: string) => string;
	readonly pathApi: {
		readonly join: (...parts: string[]) => string;
		readonly dirname: (value: string) => string;
		readonly basename: (value: string) => string;
		readonly isAbsolute: (value: string) => boolean;
		readonly sep: string;
		readonly win32Resolve: (...parts: string[]) => string;
	};
	readonly platform: string;
}

export interface CanonicalPath {
	readonly path: string;
	readonly foldCase: boolean;
}

export interface CanonicalRule {
	readonly prefix: string | undefined;
	readonly foldCase: boolean;
	readonly suffix: string;
	readonly wildcardOnly: boolean;
}

export interface PathIdentity {
	canonical(executed: string, cwd?: string): CanonicalPath;
	canonicalRule(pattern: string, cwd?: string): CanonicalRule | undefined;
	volumeFoldCase(existingPath: string): boolean;
}

export function createPathIdentity(primitives: PathIdentityPrimitives): PathIdentity;
