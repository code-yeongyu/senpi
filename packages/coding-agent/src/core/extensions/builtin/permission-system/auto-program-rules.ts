import { type ClassifiedWord, classifyWords, type ProgramSpec, type WordRole } from "./auto-shell-grammar.ts";
import type { ShellWord } from "./auto-shell-segments.ts";

/** Classifies a command's words, or undefined when the program or any word is not understood. */
export type ProgramRule = (args: readonly ShellWord[]) => ClassifiedWord[] | undefined;

const all = (role: WordRole) => (): WordRole => role;
const firstIs =
	(first: WordRole, rest: WordRole) =>
	(index: number): WordRole =>
		index === 0 ? first : rest;

const flags = (names: string, role: true | WordRole = true): Record<string, true | WordRole> =>
	Object.fromEntries(names.split(" ").map((name) => [name, role]));

const spec =
	(value: ProgramSpec): ProgramRule =>
	(args) =>
		classifyWords(args, value);

/**
 * grep and rg: the first operand is the pattern unless a pattern came from `-e`/`--regexp`, in
 * which case every operand is a file to read.
 */
const searchSpec =
	(value: ProgramSpec): ProgramRule =>
	(args) => {
		const patternFromFlag = args.some(
			(word) => word.text === "--regexp" || word.text.startsWith("--regexp=") || /^-[^-]*e/.test(word.text),
		);
		return classifyWords(args, patternFromFlag ? { ...value, operand: all("read-file"), minOperands: 1 } : value);
	};

const READ_FILES: ProgramSpec = { flags: {}, operand: all("read-file"), minOperands: 1 };

const SPECS: ReadonlyArray<readonly [string, ProgramRule]> = [
	["pwd", spec({ flags: {}, operand: all("text"), maxOperands: 0 })],
	["true", spec({ flags: {}, operand: all("text"), maxOperands: 0 })],
	["echo", spec({ flags: flags("-n -e -E"), operand: all("text") })],
	["which", spec({ flags: flags("-a"), operand: all("text"), minOperands: 1 })],
	[
		"ls",
		spec({
			flags: flags("-a -A -l -h -1 -R -t -S -r -d -F -p --all --almost-all --human-readable --recursive"),
			operand: all("list"),
		}),
	],
	["cat", spec({ ...READ_FILES, flags: flags("-n -b -s -A -e -t -v") })],
	["head", spec({ ...READ_FILES, flags: { ...flags("-n -c --lines --bytes", "text"), ...flags("-q -v --quiet") } })],
	["tail", spec({ ...READ_FILES, flags: { ...flags("-n -c --lines --bytes", "text"), ...flags("-q -v --quiet") } })],
	["wc", spec({ ...READ_FILES, flags: flags("-l -w -c -m -L --lines --words --bytes --chars") })],
	[
		"diff",
		spec({
			...READ_FILES,
			flags: { ...flags("-u -q -s -w -b -B -i --brief"), ...flags("-U --unified", "text") },
			minOperands: 2,
			maxOperands: 2,
		}),
	],
	["stat", spec({ flags: flags("-L"), operand: all("list"), minOperands: 1 })],
	["file", spec({ flags: flags("-b -i -L --brief --mime"), operand: all("read-file"), minOperands: 1 })],
	[
		"cut",
		spec({
			...READ_FILES,
			flags: {
				...flags("-d -f -c -b --delimiter --fields --characters --bytes", "text"),
				...flags("-s --only-delimited"),
			},
		}),
	],
	[
		"grep",
		searchSpec({
			flags: {
				...flags(
					"-i -n -c -l -L -v -w -x -o -q -s -H -h -F -E --ignore-case --line-number --count --fixed-strings --extended-regexp --files-with-matches",
				),
				...flags("-e -m -A -B -C --regexp --max-count --after-context --before-context --context", "text"),
			},
			operand: firstIs("text", "read-file"),
			minOperands: 2,
		}),
	],
	[
		"rg",
		searchSpec({
			flags: {
				...flags(
					"-i -n -c -l -v -w -x -o -F -S -N --ignore-case --line-number --count --fixed-strings --smart-case --files-with-matches --no-heading",
				),
				...flags("-e -m -A -B -C --regexp --max-count --after-context --before-context --context", "text"),
			},
			operand: firstIs("text", "read-file"),
			minOperands: 2,
		}),
	],
];

const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/;

/**
 * A git operand that is not shaped like a ref is a path; a ref-shaped one (`HEAD`, `main`, `notes`)
 * is still a path when something exists at that name, which the judge checks.
 */
const gitOperand = (_index: number, _count: number, text: string): WordRole =>
	GIT_REF.test(text) && !text.includes("..") ? "ref-or-path" : "list";

const GIT_READ_SUBCOMMANDS: Readonly<Record<string, ProgramSpec>> = {
	status: { flags: flags("-s -b -u --short --branch --porcelain --untracked-files"), operand: all("list") },
	diff: {
		flags: flags("--stat --cached --staged --name-only --name-status --numstat --no-color --color -w"),
		operand: gitOperand,
	},
	log: {
		flags: {
			...flags("--oneline --graph --decorate --stat --no-color --all --reverse --name-only --name-status"),
			...flags("-n --max-count --since --until --author --format --pretty", "text"),
		},
		operand: gitOperand,
	},
	"rev-parse": { flags: flags("--abbrev-ref --short --show-toplevel --verify"), operand: gitOperand },
	"ls-files": {
		flags: flags("-m -o -d -s --modified --others --deleted --stage --exclude-standard"),
		operand: all("list"),
	},
	blame: {
		flags: { ...flags("-w -s --porcelain"), ...flags("-L", "text") },
		operand: all("read-file"),
		minOperands: 1,
	},
	branch: {
		flags: flags("-a -r -v -vv --all --remotes --verbose --list --show-current"),
		operand: all("text"),
		maxOperands: 0,
	},
};

const SUMMARY_ONLY = new Set(["--stat", "--name-only", "--name-status", "--numstat"]);

/**
 * Read-only git subcommands only; any global option (`-c`, `-C`, `--git-dir`, a pager) asks.
 * `diff` prints file contents, which can include a tracked secret, so it passes only in a summary
 * form; `show` is not listed (`git show <blob id>` prints any tracked file), no operand may name an
 * object path or a full object id, and an operand that is not a plain ref is checked as a path.
 */
const gitRule: ProgramRule = (args) => {
	const [sub, ...rest] = args;
	if (sub === undefined) return undefined;
	const subSpec = GIT_READ_SUBCOMMANDS[sub.text];
	// A flag's value (`-n 1000`) is not an object id; every other word is checked.
	const isFlagValue = (index: number) => {
		const previous = rest[index - 1]?.text;
		return previous !== undefined && typeof subSpec?.flags[previous] === "string";
	};
	if (
		subSpec === undefined ||
		rest.some(
			(word, index) => word.text.includes(":") || (!isFlagValue(index) && /^[0-9a-f]{4,64}$/i.test(word.text)),
		)
	) {
		return undefined;
	}
	if (sub.text === "diff" && !rest.some((word) => SUMMARY_ONLY.has(word.text))) return undefined;
	return classifyWords(rest, subSpec);
};

export const PROGRAM_RULES: ReadonlyMap<string, ProgramRule> = new Map<string, ProgramRule>([
	...SPECS,
	["git", gitRule],
]);
