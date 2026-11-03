// The `run` git grammar (S40 PR 2, design v2.6, senpi#5645): every argument of every admitted subcommand has a declared
// position and kind, taken from the memory component's call sites. A flag never takes a value unless its shape says so,
// so a boolean flag cannot swallow the next argument, and a path is only ever a `path`/`worktree` slot the hand confines.

export type Kind =
	| "rev"
	| "range"
	| "revish"
	| "object"
	| "blobref"
	| "ref"
	| "refpat"
	| "branch"
	| "refspec"
	| "url"
	| "msg"
	| "count"
	| "mode"
	| "oid"
	| "filter"
	| "fmt"
	| "iso"
	| "relpath"
	| "gitpath"
	| "path"
	| "worktree";

/** A path-kind argument the hand still has to confine on the device before git runs. */
export interface TypedPath {
	readonly kind: "path" | "worktree";
	readonly value: string;
}

export type Item =
	| string
	| { readonly kind: Kind }
	| { readonly prefix: string; readonly kind: Kind }
	| { readonly optional: readonly Item[] }
	| { readonly repeat: readonly Item[]; readonly min: number };

const k = (kind: Kind): Item => ({ kind });
const eq = (prefix: string, kind: Kind): Item => ({ prefix, kind });
const opt = (...optional: Item[]): Item => ({ optional });
const rep = (min: number, ...repeat: Item[]): Item => ({ repeat, min });

const NUL = /\0/;
const REV = /^(?![-./~:])[A-Za-z0-9._/@{}^~+-]+$/;
const REL = /^(?![/-])(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/;
const rev = (value: string): boolean => REV.test(value) && !value.includes("..") && !value.includes("//");
const range = (value: string): boolean => {
	const parts = value.split("..");
	return parts.length === 2 && parts.every(rev);
};
const blobref = (value: string): boolean => {
	const at = value.indexOf(":");
	return at >= 0 && (at === 0 || rev(value.slice(0, at))) && REL.test(value.slice(at + 1));
};
const filesystem = (value: string): boolean => value.length > 0 && !NUL.test(value) && !/^[-:]/.test(value);

const KINDS: Readonly<Record<Kind, (value: string) => boolean>> = {
	rev,
	range,
	revish: (value) => rev(value) || range(value),
	object: (value) => rev(value) || blobref(value),
	blobref,
	ref: (value) => value === "HEAD" || (/^refs\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..")),
	refpat: (value) => /^refs\/[A-Za-z0-9._/-]+\*?$/.test(value) && !value.includes(".."),
	branch: (value) => /^(?![-./])[A-Za-z0-9._/-]+$/.test(value) && !value.includes(".."),
	refspec: (value) => /^[A-Za-z0-9._/]+(?:-[A-Za-z0-9._/]+)*:[A-Za-z0-9._/-]+$/.test(value) && !value.includes(".."),
	url: (value) =>
		/^(?:https:\/\/|ssh:\/\/|file:\/\/\/)[^\s\0]+$/.test(value) ||
		/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(value),
	msg: (value) => !NUL.test(value),
	count: (value) => /^\d{1,9}$/.test(value),
	mode: (value) => /^(?:100644|100755|120000|160000)$/.test(value),
	oid: (value) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value),
	filter: (value) => /^[ACDMRTUXB]+$/i.test(value),
	fmt: (value) => !NUL.test(value),
	iso: (value) => /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value),
	relpath: (value) => REL.test(value),
	gitpath: (value) => value === "index" || value === "MERGE_HEAD",
	path: filesystem,
	worktree: filesystem,
};

const FORMAT = eq("--format=", "fmt");
const LOG_RECORD = "--format=%x1e%H%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%cI";

/** Every admitted shape, per subcommand: the memory component's call sites, nothing wider. */
export const SHAPES: Readonly<Record<string, readonly (readonly Item[])[]>> = {
	add: [["-A", "--", rep(1, k("path"))]],
	branch: [["--show-current"], ["-D", k("branch")]],
	"cat-file": [["blob", k("object")], ["--batch"], ["-e", k("blobref")]],
	checkout: [[k("rev"), "--", k("path")]],
	commit: [["-q", "--no-verify", "-m", k("msg")]],
	"commit-tree": [[k("rev"), opt("-p", k("rev")), "-F", "-"]],
	"count-objects": [["-v"]],
	diff: [
		["--cached", "-M", "-C", "-z", "--raw", "--no-abbrev"],
		["--name-only", "-z", eq("--diff-filter=", "filter"), k("rev"), k("rev"), "--"],
		["--name-status", "-M", "-z", k("range"), "--"],
		["--cached", "--quiet", k("rev"), "--"],
		["--no-renames", "--name-only", "-z", k("range"), "--", k("path")],
		["--name-only", "-z", k("range"), "--"],
		["--name-only", eq("--diff-filter=", "filter")],
	],
	"diff-files": [["--name-only", "-z"]],
	"diff-tree": [
		["-r", "-m", "--no-commit-id", "--no-renames", eq("--diff-filter=", "filter"), "--raw", "-z", k("rev")],
	],
	"for-each-ref": [[FORMAT, rep(1, k("refpat"))]],
	"hash-object": [
		[opt("-w"), "--no-filters", "--stdin"],
		[opt("-w"), eq("--path=", "relpath"), "--stdin"],
	],
	init: [["--template="]],
	log: [
		["-1", FORMAT, k("rev")],
		[{ prefix: "-", kind: "count" }, FORMAT, k("rev")],
		[
			FORMAT,
			"--name-only",
			"-z",
			"--no-renames",
			"--diff-merges=first-parent",
			eq("--diff-filter=", "filter"),
			rep(0, k("revish")),
			"--",
		],
		[
			LOG_RECORD,
			opt("--name-only", "-z", "--no-renames", "--full-diff"),
			opt("--fixed-strings", "--all-match", rep(1, eq("--grep=", "msg"))),
			opt("-n", k("count")),
			opt(eq("--since=", "iso")),
			opt(k("revish")),
			opt("--", rep(1, k("path"))),
		],
	],
	"ls-files": [
		["--stage", "-z", "--", k("path")],
		["--eol", "-z"],
	],
	"ls-remote": [[k("url"), k("ref")]],
	"ls-tree": [
		["-r", "--name-only", "-z", k("rev"), opt("--", k("path"))],
		["-r", "-l", "-z", k("rev")],
		["-r", "-z", k("rev")],
		["-z", k("rev"), "--", k("path")],
	],
	maintenance: [["run", "--task=loose-objects", "--quiet"]],
	merge: [
		[],
		["--abort"],
		[opt("--no-ff"), opt("-m", k("msg")), k("rev")],
		["--no-ff", k("rev"), rep(1, "-m", k("msg"))],
	],
	"merge-base": [["--is-ancestor", k("rev"), k("rev")]],
	"prune-packed": [["--quiet"]],
	push: [["--quiet", k("url"), k("refspec")]],
	"read-tree": [["--empty"], [k("rev")]],
	remote: [["-v"]],
	reset: [["--soft", k("rev")]],
	restore: [["--source=HEAD", "--staged", opt("--worktree"), "--", rep(1, k("path"))]],
	"rev-list": [
		[opt("--count"), k("range")],
		["--reverse", k("range")],
	],
	"rev-parse": [
		["--verify", opt("--quiet"), k("rev")],
		["-q", "--verify", k("rev")],
		["--git-path", k("gitpath")],
		["--git-common-dir"],
	],
	rm: [
		["-q", "--cached", opt("-f"), "--ignore-unmatch", "--", rep(1, k("path"))],
		["-rf", "-q", "--ignore-unmatch", "--", k("path")],
	],
	show: [["-s", FORMAT, k("rev")], [k("blobref")]],
	"show-ref": [["--verify", k("ref")]],
	status: [["--porcelain", opt("--untracked-files=all", opt("--", rep(1, k("path"))))]],
	"symbolic-ref": [["HEAD", k("ref")]],
	"update-index": [
		["--force-remove", "--", k("path")],
		["--add", "--cacheinfo", k("mode"), k("oid"), k("path")],
		["-q", "-z", "--stdin"],
	],
	"update-ref": [["-m", k("msg"), "HEAD", k("rev"), k("rev")]],
	worktree: [
		["add", "-b", k("branch"), k("worktree"), k("rev")],
		["remove", opt("--force"), k("worktree")],
		["list", "--porcelain"],
		["prune"],
	],
	"write-tree": [[]],
};

/** Matches `items` against `args` from position `at`; `then` continues with the rest, so optional and repeated groups backtrack. */
function match(
	items: readonly Item[],
	args: readonly string[],
	at: number,
	paths: TypedPath[],
	then: (at: number) => boolean,
): boolean {
	const [item, ...rest] = items;
	if (item === undefined) return then(at);
	const next = (to: number): boolean => match(rest, args, to, paths, then);
	if (typeof item === "string") return args[at] === item && next(at + 1);
	if ("optional" in item) return match(item.optional, args, at, paths, next) || next(at);
	if ("repeat" in item) {
		const again = (count: number, from: number): boolean =>
			(count >= item.min && next(from)) ||
			match(item.repeat, args, from, paths, (to) => to > from && again(count + 1, to));
		return again(0, at);
	}
	const arg = args[at];
	if (arg === undefined) return false;
	const value = "prefix" in item ? (arg.startsWith(item.prefix) ? arg.slice(item.prefix.length) : undefined) : arg;
	if (value === undefined || !KINDS[item.kind](value)) return false;
	const typed = item.kind === "path" || item.kind === "worktree";
	if (typed) paths.push({ kind: item.kind, value });
	if (next(at + 1)) return true;
	if (typed) paths.pop();
	return false;
}

/** The path arguments of the first shape `args` matches exactly, or undefined when no shape admits them. */
export function matchShape(sub: string, args: readonly string[]): readonly TypedPath[] | undefined {
	for (const shape of SHAPES[sub] ?? []) {
		const paths: TypedPath[] = [];
		if (match(shape, args, 0, paths, (at) => at === args.length)) return paths;
	}
	return undefined;
}
