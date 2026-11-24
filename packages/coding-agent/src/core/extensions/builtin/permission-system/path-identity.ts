// Host twin of packages/senpi-codemode/src/kernels/shared/path-identity.js: the same canonical form
// (native realpath of the deepest existing ancestor plus the missing tail, dangling links followed,
// NFC on darwin, case folded per volume), the same PATH_IDENTITY_VERSION, pinned by one table test
// that runs both. Bump the version together with the kernel twin on any algorithm change.

export const PATH_IDENTITY_VERSION = 1;

const MISSING = new Set(["ENOENT", "ENOTDIR"]);
const MAX_DANGLING_HOPS = 40;

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

export interface PathIdentityError extends Error {
	readonly code: string;
}

function failure(code: string): PathIdentityError {
	return Object.assign(new Error(code), { code });
}

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "EUNKNOWN";
}

/** Lowercase per code point, only where the lowercase form is exactly one code point (U+0130 stays). */
export function foldCaseText(text: string): string {
	let out = "";
	for (const char of text) {
		const lower = char.toLowerCase();
		out += [...lower].length === 1 ? lower : char;
	}
	return out;
}

function stripWin32Components(value: string, sep: string): string {
	return value
		.split(sep)
		.map((part, index) => (index === 0 ? part : part.replace(/[. ]+$/u, "")))
		.join(sep);
}

export function createPathIdentity({
	realpathNative,
	lstat,
	readlink,
	pathApi,
	platform,
}: PathIdentityPrimitives): PathIdentity {
	const { join, dirname, basename, isAbsolute, sep, win32Resolve } = pathApi;
	const normalizeForm = (value: string) => (platform === "darwin" ? value.normalize("NFC") : value);
	const foldDefault = platform === "darwin" || platform === "win32";
	const foldByDevice = new Map<bigint, boolean>();

	const anchor = (value: string, cwd: string | undefined): string => {
		if (platform === "win32") {
			return stripWin32Components(cwd === undefined ? win32Resolve(value) : win32Resolve(cwd, value), sep);
		}
		if (isAbsolute(value)) return value;
		if (cwd === undefined) throw failure("ERELATIVE");
		return cwd + sep + value;
	};

	const climb = (base: string): { real: string; path: string } => {
		let existing = base;
		const missing: string[] = [];
		let hops = 0;
		let followedDangling = false;
		for (;;) {
			let real: string;
			try {
				real = realpathNative(existing);
			} catch (error) {
				const code = errorCode(error);
				if (!MISSING.has(code)) throw failure(code);
				let info: PathIdentityStats | undefined;
				try {
					info = lstat(existing);
				} catch (inner) {
					const innerCode = errorCode(inner);
					if (!MISSING.has(innerCode)) throw failure(innerCode);
					info = undefined;
				}
				if (info?.isSymbolicLink()) {
					hops += 1;
					if (hops > MAX_DANGLING_HOPS) throw failure("ELOOP");
					const target = readlink(existing);
					existing = isAbsolute(target) ? target : join(dirname(existing), target);
					followedDangling = true;
					continue;
				}
				if (followedDangling && missing.length > 0) throw failure("EDANGLING");
				missing.unshift(basename(existing));
				const parent = dirname(existing);
				if (parent === existing) throw failure(code);
				existing = parent;
				continue;
			}
			return { real, path: missing.length ? join(real, ...missing) : real };
		}
	};

	const sameDevice = (value: string, device: bigint): boolean => {
		try {
			return lstat(value, { bigint: true }).dev === device;
		} catch {
			return false;
		}
	};

	const probeFoldCase = (existingPath: string, device: bigint): boolean => {
		let probe = existingPath;
		for (;;) {
			const name = basename(probe);
			const chars = [...name];
			const index = chars.findIndex((char) => char.toLowerCase() !== char.toUpperCase());
			if (index >= 0) {
				const char = chars[index] ?? "";
				chars[index] = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
				const swapped = join(dirname(probe), chars.join(""));
				try {
					const original = lstat(probe, { bigint: true });
					const variant = lstat(swapped, { bigint: true });
					return original.dev === variant.dev && original.ino === variant.ino;
				} catch {
					return false;
				}
			}
			const parent = dirname(probe);
			if (parent === probe) return foldDefault;
			probe = parent;
			if (!sameDevice(probe, device)) return foldDefault;
		}
	};

	const volumeFoldCase = (existingPath: string): boolean => {
		let device: bigint;
		try {
			device = lstat(existingPath, { bigint: true }).dev;
		} catch {
			return foldDefault;
		}
		const cached = foldByDevice.get(device);
		if (cached !== undefined) return cached;
		const answer = probeFoldCase(existingPath, device);
		foldByDevice.set(device, answer);
		return answer;
	};

	const canonical = (executed: string, cwd?: string): CanonicalPath => {
		const { real, path } = climb(anchor(executed, cwd));
		return { path: normalizeForm(path), foldCase: volumeFoldCase(real) };
	};

	const canonicalRule = (pattern: string, cwd?: string): CanonicalRule | undefined => {
		if (pattern === "*") return undefined;
		const wildcard = pattern.search(/[*?]/u);
		if (wildcard < 0) {
			const { path, foldCase } = canonical(pattern, cwd);
			return { prefix: path, foldCase, suffix: "", wildcardOnly: false };
		}
		const boundary = Math.max(pattern.lastIndexOf("/", wildcard), pattern.lastIndexOf(sep, wildcard));
		if (boundary < 0) {
			return { prefix: undefined, foldCase: foldDefault, suffix: normalizeForm(pattern), wildcardOnly: true };
		}
		const { path, foldCase } = canonical(pattern.slice(0, boundary) || sep, cwd);
		return { prefix: path, foldCase, suffix: normalizeForm(pattern.slice(boundary)), wildcardOnly: false };
	};

	return { canonical, canonicalRule, volumeFoldCase };
}

/**
 * Whether a rule's canonical form covers a request's canonical path. The request target's volume
 * decides the fold (N6): on a case-insensitive volume both sides are folded, otherwise neither.
 * Both sides go through the mount rewrite first: a native realpath that keeps the firmlink spelling
 * (Node's does on darwin) must still meet a rule written on the canonical one, and the reverse.
 */
export function identityMatches(
	rule: CanonicalRule,
	request: CanonicalPath,
	match: (value: string, pattern: string) => boolean,
	sep: string,
	rewrite: (value: string) => string = (value) => value,
): boolean {
	const fold = request.foldCase ? foldCaseText : (value: string) => value;
	const value = fold(rewrite(request.path));
	if (rule.wildcardOnly || rule.prefix === undefined) return match(value, fold(rule.suffix));
	const prefix = fold(rewrite(rule.prefix));
	if (rule.suffix === "") return value === prefix;
	if (value !== prefix && !value.startsWith(prefix === sep ? sep : prefix + sep)) return false;
	return match(value.slice(prefix.length), fold(rule.suffix));
}
