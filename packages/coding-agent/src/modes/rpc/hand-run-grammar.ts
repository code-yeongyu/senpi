// The `run` git grammar (S40 PR 2, design v2.5, senpi#5645): scanned from the memory component's call sites.

/** Each subcommand's flags exactly as the memory component passes them (v2.5): a flag must equal one, or start with a
 * declared `--flag=` prefix; git's abbreviations of long options therefore never match. */
export const FLAGS: Readonly<
	Record<string, { readonly exact: readonly string[]; readonly prefixes: readonly string[] }>
> = {
	add: { exact: ["-A"], prefixes: [] },
	branch: { exact: ["--show-current", "-D"], prefixes: [] },
	"cat-file": { exact: ["--batch", "-e"], prefixes: [] },
	checkout: { exact: [], prefixes: [] },
	commit: { exact: ["--no-verify", "-m", "-q"], prefixes: [] },
	config: { exact: ["--get", "--local", "--unset-all"], prefixes: [] },
	"count-objects": { exact: ["-v"], prefixes: [] },
	diff: {
		exact: [
			"--cached",
			"--name-only",
			"--name-status",
			"--no-abbrev",
			"--no-renames",
			"--quiet",
			"--raw",
			"-C",
			"-M",
			"-z",
		],
		prefixes: ["--diff-filter="],
	},
	"diff-files": { exact: ["--name-only", "-z"], prefixes: [] },
	"diff-tree": { exact: ["--no-commit-id", "--no-renames", "--raw", "-m", "-r", "-z"], prefixes: ["--diff-filter="] },
	"for-each-ref": { exact: [], prefixes: ["--format="] },
	init: { exact: [], prefixes: ["--template="] },
	log: {
		exact: ["--full-diff", "--name-only", "--no-renames", "-1", "-z"],
		prefixes: ["--diff-filter=", "--diff-merges=", "--format="],
	},
	"ls-files": { exact: ["--eol", "--stage", "-z"], prefixes: [] },
	"ls-tree": { exact: ["--name-only", "-l", "-r", "-z"], prefixes: [] },
	maintenance: { exact: ["--quiet"], prefixes: ["--task="] },
	merge: { exact: ["--abort", "--no-ff", "-m"], prefixes: [] },
	"merge-base": { exact: ["--is-ancestor"], prefixes: [] },
	"prune-packed": { exact: ["--quiet"], prefixes: [] },
	push: { exact: ["--quiet"], prefixes: [] },
	"read-tree": { exact: ["--empty"], prefixes: [] },
	remote: { exact: ["-v"], prefixes: [] },
	reset: { exact: ["--soft"], prefixes: [] },
	restore: { exact: ["--staged", "--worktree"], prefixes: ["--source="] },
	"rev-list": { exact: ["--count", "--reverse"], prefixes: [] },
	"rev-parse": { exact: ["--git-common-dir", "--git-path", "--quiet", "--verify", "-q"], prefixes: [] },
	rm: { exact: ["--cached", "--ignore-unmatch", "-f", "-q", "-rf"], prefixes: [] },
	show: { exact: ["-s"], prefixes: ["--format="] },
	"show-ref": { exact: ["--verify"], prefixes: [] },
	status: { exact: ["--porcelain"], prefixes: ["--untracked-files="] },
	"update-index": { exact: ["--add", "--cacheinfo", "--force-remove", "--stdin", "-q", "-z"], prefixes: [] },
	"update-ref": { exact: ["-m"], prefixes: [] },
	worktree: { exact: ["--force", "--porcelain", "-b"], prefixes: [] },
};

/** Flags whose next argument is their value (a commit message may start with `-`). */
export const VALUE_FLAGS = new Set(["-m", "-b", "-p", "-F", "--cacheinfo", "--git-path"]);
