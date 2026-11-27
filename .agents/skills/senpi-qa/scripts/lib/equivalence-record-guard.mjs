// A fused-equivalence golden is committed to a public repository, so a record run must never capture anything private
// to the recording host. The CLI under test loads context and rule files by walking up from its cwd, and the case cwd
// lives under the sandbox temp dir: a temp dir below a home directory with its own AGENTS.md put that file into a
// recorded system prompt (senpi#7550). The recorder refuses such a host before any case runs, and refuses to write a
// golden or a baseline manifest that carries a context wrapper, a context-file name or a real home path.
//
// The file names and rule locations come from the CLI's own discovery code, so the guard never checks fewer than the
// CLI reads; names are matched case-insensitively, which also covers case-insensitive filesystems.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { CONTEXT_FILE_NAMES } from "../../../../../packages/coding-agent/src/core/context-file-names.ts";
import {
	PROJECT_RULES_START_MARKER,
	PROJECT_RULE_SUBDIRS,
	PROJECT_SINGLE_FILES,
} from "../../../../../packages/coding-agent/src/core/extensions/builtin/rules/rules/constants.ts";

/** Paths, relative to a directory, whose presence there would reach a child whose cwd is at or below it. */
const RULE_PATHS = [
	...CONTEXT_FILE_NAMES,
	...PROJECT_SINGLE_FILES,
	...PROJECT_RULE_SUBDIRS.map(([parent, sub]) => `${parent}/${sub}`),
];

/** The wrappers senpi puts around loaded context (system-prompt.ts) and rules (rules/constants.ts). */
export const CONTEXT_WRAPPERS = ["<project_context>", "<project_instructions", PROJECT_RULES_START_MARKER];

const HOME_ROOTS = ["/Users/", "/home/", "/root/", "C:\\Users\\"];

/** Every leak marker the serialized text contains (case-insensitive), with its count; empty means it may be written. */
export function goldenLeaks(serialized, home) {
	const text = serialized.replaceAll("\\\\", "\\").toLowerCase();
	const markers = new Set(
		[...CONTEXT_WRAPPERS, ...CONTEXT_FILE_NAMES, ...HOME_ROOTS, ...(home ? [home] : [])].map((m) => m.toLowerCase()),
	);
	return [...markers]
		.map((marker) => ({ marker, count: text.split(marker).length - 1 }))
		.filter((leak) => leak.count > 0);
}

function inside(child, parent) {
	const path = relative(parent.toLowerCase(), child.toLowerCase());
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function entriesLower(dir) {
	try {
		return new Map(readdirSync(dir).map((name) => [name.toLowerCase(), name]));
	} catch {
		return new Map();
	}
}

/** The rule paths present in `dir`, matched case-insensitively segment by segment. */
function rulePathsIn(dir) {
	const found = [];
	for (const rulePath of RULE_PATHS) {
		let current = dir;
		for (const segment of rulePath.split("/")) {
			const actual = current && entriesLower(current).get(segment.toLowerCase());
			current = actual ? join(current, actual) : undefined;
		}
		if (current) found.push(current);
	}
	return [...new Set(found)];
}

/** Why this host cannot record: the sandbox temp dir is inside the home dir, or a rule file sits in it or above it. */
export function recordHostProblems({ temp, home }) {
	const real = realpathSync.native(temp);
	const problems = [];
	if (existsSync(home) && inside(real, realpathSync.native(home)))
		problems.push(`the sandbox temp dir ${real} is inside the home dir ${home}; set TMPDIR outside it`);
	for (let dir = real; ; dir = dirname(dir)) {
		for (const path of rulePathsIn(dir))
			problems.push(`${path} is at or above the sandbox temp dir ${real}; a recorded prompt would carry it`);
		if (dirname(dir) === dir) break;
	}
	return problems;
}
