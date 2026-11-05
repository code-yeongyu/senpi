import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { realpathWithoutOpenStrict } from "../../../../utils/paths.ts";
import type { MountSnapshot } from "./mount-table.ts";
import { foldCaseText } from "./path-identity.ts";

/**
 * Filesystem types whose names a positive confirmation may trust: the design's measured allowlist. On
 * these, a path whose every component its parent lists verbatim is the spelling native realpath returns
 * (case folding, per-directory included, only resolves spellings the parent does not list). Every other
 * type (devfs, fuse*, autofs, proc, SMB, unmeasured local types) stays alias-bearing.
 */
export const REAL_FS: ReadonlySet<string> = new Set([
	"apfs",
	"hfs",
	"ext4",
	"xfs",
	"btrfs",
	"zfs",
	"tmpfs",
	"ntfs",
	"exfat",
	"overlay",
	"virtiofs",
	"nfs",
	"nfs4",
]);
export const DETECTOR_MAX_READDIR = 256;
export const DETECTOR_MAX_ENTRIES = 5000;

/** Mount points that are aliases of the darwin Data volume: the Data mount and every mount of its device. */
export function mountAliasRoots(snapshot: MountSnapshot, platform: string = process.platform): string[] {
	if (platform !== "darwin") return [];
	const dataDevice = snapshot.mounts.find((mount) => mount.on === "/System/Volumes/Data")?.dev;
	return snapshot.mounts
		.filter(
			(mount) =>
				mount.on === "/System/Volumes/Data" ||
				(dataDevice !== undefined && mount.dev === dataDevice && mount.on !== "/"),
		)
		.map((mount) => mount.on);
}

const DARWIN_FIRMLINKS = "/usr/share/firmlinks";

/** The darwin firmlink entries (`/<entry>` lives on `/System/Volumes/Data/<entry>`); empty elsewhere. */
export function readFirmlinks(platform: string = process.platform): string[] {
	if (platform !== "darwin") return [];
	try {
		return readFileSync(DARWIN_FIRMLINKS, "utf8")
			.split("\n")
			.map((line) => line.split("\t")[0]?.trim() ?? "")
			.filter((entry) => entry.startsWith("/"));
	} catch {
		return [];
	}
}

/** Lexical firmlink rewrite: `/<entry>/...` -> `/System/Volumes/Data/<entry>/...`. */
export function createMountRewrite(firmlinks: readonly string[]): (value: string) => string {
	const sorted = [...firmlinks].sort((a, b) => b.length - a.length);
	return (value) => {
		for (const entry of sorted) {
			if (value === entry || value.startsWith(`${entry}/`)) return `/System/Volumes/Data${value}`;
		}
		return value;
	};
}

/** The longest mount point that is a lexical prefix of the (rewritten) path; `unknown` while degraded. */
export function volumeKeyFor(
	snapshot: MountSnapshot | undefined,
	rewrite: (value: string) => string,
	value: string,
): string {
	if (!snapshot || snapshot.degraded) return "unknown";
	const rewritten = rewrite(value);
	for (const mount of snapshot.mounts) {
		if (rewritten === mount.on || rewritten.startsWith(mount.on === "/" ? "/" : `${mount.on}/`)) return mount.on;
	}
	return "/";
}

/**
 * `reaches()` of design 6.5.1: the open-free walk of a rule prefix, mount-rewritten and folded like the
 * request's canonical path, is a component prefix of (or equal to) it. Any walker error answers true:
 * containment may only be over-inclusive.
 */
export function containsPrefix(
	rulePrefix: string,
	requestCanonical: string,
	rewrite: (value: string) => string,
	foldCase: boolean,
	walk: (value: string) => string = realpathWithoutOpenStrict,
): boolean {
	const fold = foldCase ? foldCaseText : (value: string) => value;
	let walked: string;
	try {
		walked = walk(rulePrefix);
	} catch {
		return true;
	}
	const lhs = fold(rewrite(walked));
	const rhs = fold(rewrite(requestCanonical));
	return lhs === rhs || rhs.startsWith(lhs === "/" ? "/" : `${lhs}/`);
}

/** Design oracle (6.1.2): native realpath of the deepest existing ancestor plus the missing tail, dangling links followed. */
export function oracle(value: string): string {
	let existing = value;
	const missing: string[] = [];
	let hops = 0;
	let followedDangling = false;
	for (;;) {
		try {
			const real = realpathSync.native(existing);
			return missing.length ? join(real, ...missing) : real;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			let link = false;
			try {
				link = lstatSync(existing).isSymbolicLink();
			} catch (inner) {
				const innerCode = (inner as NodeJS.ErrnoException).code;
				if (innerCode !== "ENOENT" && innerCode !== "ENOTDIR") throw inner;
			}
			if (link) {
				hops += 1;
				if (hops > 40) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
				const target = readlinkSync(existing);
				existing = isAbsolute(target) ? target : join(dirname(existing), target);
				followedDangling = true;
				continue;
			}
			if (followedDangling && missing.length > 0) throw Object.assign(new Error("EDANGLING"), { code: "EDANGLING" });
			const parent = dirname(existing);
			if (parent === existing) throw error;
			missing.unshift(basename(existing));
			existing = parent;
		}
	}
}

export type Verdict = { readonly alias: boolean; readonly reasons: string[]; readonly readdirs: number };

export interface DetectorBudget {
	readonly maxReaddir: number;
	readonly maxEntries: number;
}

export interface DetectorIO {
	readonly walk: (value: string) => string;
	readonly readdir: (value: string) => string[];
	readonly lstat: (value: string) => unknown;
}

const defaultIO: DetectorIO = {
	walk: realpathWithoutOpenStrict,
	readdir: (value) => readdirSync(value),
	lstat: (value) => lstatSync(value),
};

function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "UNKNOWN";
}

/**
 * The INVERTED alias detector (design 5.4): a path is "no alias" ONLY when every component is
 * positively confirmed; anything unconfirmed, unrecognised, over budget or errored is "alias in play".
 */
export function createDetector(
	snapshot: MountSnapshot,
	budget: DetectorBudget = { maxReaddir: DETECTOR_MAX_READDIR, maxEntries: DETECTOR_MAX_ENTRIES },
	io: DetectorIO = defaultIO,
	platform: string = process.platform,
): (value: string) => Verdict {
	const mounts = [...snapshot.mounts].sort((a, b) => b.on.length - a.on.length);
	const ambiguous = new Set(snapshot.ambiguous);
	const roots = mountAliasRoots(snapshot, platform);
	const mountFor = (value: string) =>
		mounts.find((mount) => value === mount.on || value.startsWith(mount.on === "/" ? "/" : `${mount.on}/`));
	/** The reason a component's mount cannot confirm it: no entry, a type outside the allowlist, or an ambiguous point. */
	const unconfirmedBy = (value: string): string | undefined => {
		const mount = mountFor(value);
		if (!mount || !REAL_FS.has(mount.type)) return `fs-type:${mount?.type ?? "no-mount-entry"}`;
		return ambiguous.has(mount.on) ? `mount-point-ambiguous:${mount.on}` : undefined;
	};
	const mountAliased = (value: string) => roots.some((root) => value === root || value.startsWith(`${root}/`));
	return (value) => {
		const reasons: string[] = [];
		let readdirs = 0;
		if (snapshot.degraded) reasons.push("mount-snapshot-degraded");
		if (!isAbsolute(value)) reasons.push("relative");
		if (value.split(sep).some((component) => component === "." || component === "..")) reasons.push("dot-component");
		if (value !== "/" && (value.endsWith("/") || value.includes("//"))) reasons.push("separator-spelling");
		if (mountAliased(value)) reasons.push("mount-alias");
		let walked: string;
		try {
			walked = io.walk(value);
		} catch (error) {
			reasons.push(`walker:${codeOf(error)}`);
			return { alias: true, reasons, readdirs };
		}
		if (walked !== value) reasons.push("walker-differs");
		if (mountAliased(walked)) reasons.push("mount-alias-after-walk");
		if (reasons.length) return { alias: true, reasons, readdirs };
		const root = parse(walked).root;
		const parts = walked.slice(root.length).split(sep).filter(Boolean);
		let parent = root;
		const rootReason = unconfirmedBy(root);
		if (rootReason !== undefined) {
			reasons.push(rootReason);
			return { alias: true, reasons, readdirs };
		}
		for (const part of parts) {
			const here = join(parent, part);
			const reason = unconfirmedBy(here);
			if (reason !== undefined) {
				reasons.push(`${reason}@${here}`);
				break;
			}
			let entries: string[];
			try {
				readdirs += 1;
				if (readdirs > budget.maxReaddir) throw Object.assign(new Error("EBUDGET"), { code: "EBUDGET" });
				entries = io.readdir(parent);
			} catch (error) {
				reasons.push(`readdir:${codeOf(error)}@${parent}`);
				break;
			}
			if (entries.length > budget.maxEntries) {
				reasons.push(`EBUDGET-entries@${parent}`);
				break;
			}
			if (!entries.includes(part)) {
				let exists = true;
				try {
					io.lstat(here);
				} catch (error) {
					const code = codeOf(error);
					if (code !== "ENOENT" && code !== "ENOTDIR") {
						reasons.push(`lstat:${code}@${here}`);
						break;
					}
					exists = false;
				}
				if (exists) {
					reasons.push(`not-enumerable@${here}`);
					break;
				}
				let full = false;
				try {
					io.lstat(walked);
					full = true;
				} catch (error) {
					const code = codeOf(error);
					if (code !== "ENOENT" && code !== "ENOTDIR") reasons.push(`lstat:${code}@${walked}`);
				}
				if (full) reasons.push(`phantom-parent@${here}`);
				break;
			}
			parent = here;
		}
		return { alias: reasons.length > 0, reasons, readdirs };
	};
}
