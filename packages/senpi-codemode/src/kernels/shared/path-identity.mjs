// Path identity for permission decisions: one canonical form per file, computed from the native
// realpath of the deepest existing ancestor plus the not-yet-existing tail, dangling links followed.
// Plain JS with injected primitives: the kernel thread captures its originals before the cwd
// patches replace `path.resolve` on the shared builtin, so nothing here may reach a live builtin.
// The host side keeps a TypeScript twin of this algorithm; both carry PATH_IDENTITY_VERSION and a
// shared table test pins them to the same answers. Bump the version on any change to the climb,
// the fold mapping or the normalization rule: a host that sees another version ignores the kernel
// value and resolves the executed path itself.

export const PATH_IDENTITY_VERSION = 1;

const MISSING = new Set(["ENOENT", "ENOTDIR"]);
const MAX_DANGLING_HOPS = 40;

function failure(code) {
	return Object.assign(new Error(code), { code });
}

/** Strip trailing dots and spaces from every component, as Win32 path normalization does. */
function stripWin32Components(value, sep) {
	return value
		.split(sep)
		.map((part, index) => (index === 0 ? part : part.replace(/[. ]+$/u, "")))
		.join(sep);
}

export function createPathIdentity({ realpathNative, lstat, readlink, pathApi, platform }) {
	const { join, dirname, basename, isAbsolute, sep, win32Resolve } = pathApi;
	const normalizeForm = (value) => (platform === "darwin" ? value.normalize("NFC") : value);
	const foldDefault = platform === "darwin" || platform === "win32";
	// Per-volume answer to "does this volume treat case variants as one name", keyed by device.
	const foldByDevice = new Map();

	const anchor = (value, cwd) => {
		if (platform === "win32") {
			return stripWin32Components(win32Resolve(cwd === undefined ? value : cwd, cwd === undefined ? "" : value), sep);
		}
		if (isAbsolute(value)) return value;
		if (cwd === undefined) throw failure("ERELATIVE");
		return cwd + sep + value;
	};

	/** The deepest existing ancestor's native realpath, dangling links followed, plus the missing tail. */
	const climb = (base) => {
		let existing = base;
		const missing = [];
		let hops = 0;
		let followedDangling = false;
		for (;;) {
			let real;
			try {
				real = realpathNative(existing);
			} catch (error) {
				const code = error?.code;
				if (!MISSING.has(code)) throw failure(code ?? "EUNKNOWN");
				let info;
				try {
					info = lstat(existing);
				} catch (inner) {
					const innerCode = inner?.code;
					if (!MISSING.has(innerCode)) throw failure(innerCode ?? "EUNKNOWN");
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

	const volumeFoldCase = (existingPath) => {
		let device;
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

	const probeFoldCase = (existingPath, device) => {
		let probe = existingPath;
		for (;;) {
			const name = basename(probe);
			const index = [...name].findIndex((char) => char.toLowerCase() !== char.toUpperCase());
			if (index >= 0) {
				const chars = [...name];
				const char = chars[index];
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

	const sameDevice = (value, device) => {
		try {
			return lstat(value, { bigint: true }).dev === device;
		} catch {
			return false;
		}
	};

	const canonical = (executed, cwd) => {
		const { real, path } = climb(anchor(executed, cwd));
		return { path: normalizeForm(path), foldCase: volumeFoldCase(real) };
	};

	const canonicalRule = (pattern, cwd) => {
		if (pattern === "*") return undefined;
		const wildcard = pattern.search(/[*?]/u);
		if (wildcard < 0) {
			const { path, foldCase } = canonical(pattern, cwd);
			return { prefix: path, foldCase, suffix: "", wildcardOnly: false };
		}
		const boundary = Math.max(pattern.lastIndexOf("/", wildcard), pattern.lastIndexOf(sep, wildcard));
		if (boundary < 0) return { prefix: undefined, foldCase: foldDefault, suffix: normalizeForm(pattern), wildcardOnly: true };
		const { path, foldCase } = canonical(pattern.slice(0, boundary) || sep, cwd);
		return { prefix: path, foldCase, suffix: normalizeForm(pattern.slice(boundary)), wildcardOnly: false };
	};

	return { canonical, canonicalRule, volumeFoldCase };
}
