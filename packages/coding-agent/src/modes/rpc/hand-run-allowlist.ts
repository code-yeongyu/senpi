/**
 * The `run` operation's allowlist (S40 PR 2, senpi#5645, design v2.2-v2.4). A hand runs only the git and lsof calls the
 * memory component makes, scanned from its sources; everything else is refused with a reason naming what was refused.
 * The hand prepends its own git globals, builds the environment from scratch, and never runs a shell. The lists below
 * are the scan's result and are covered by a behavioral test, not compared with themselves.
 */

import { matchShape, type TypedPath } from "./hand-run-grammar.ts";

export interface RunRequest {
	readonly exe: string;
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

export interface HandRunContext {
	readonly uid: number;
	readonly platform: NodeJS.Platform;
	/** The hand's own environment, read for the baseline only; the caller never supplies these. */
	readonly ownEnv: Readonly<Record<string, string | undefined>>;
}

export type RunPlan =
	| {
			readonly ok: true;
			readonly exe: "git" | "lsof";
			readonly argv: string[];
			readonly env: Record<string, string>;
			/** Path arguments the hand confines on the device before spawning (none for lsof). */
			readonly paths: readonly TypedPath[];
	  }
	| { readonly ok: false; readonly reason: string };

const HAND_GIT_PREFIX = ["-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];

const SUBCOMMANDS = new Set([
	"add",
	"branch",
	"cat-file",
	"checkout",
	"commit",
	"commit-tree",
	"config",
	"count-objects",
	"diff",
	"diff-files",
	"diff-tree",
	"for-each-ref",
	"hash-object",
	"init",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"maintenance",
	"merge",
	"merge-base",
	"prune-packed",
	"push",
	"read-tree",
	"remote",
	"reset",
	"restore",
	"rev-list",
	"rev-parse",
	"rm",
	"show",
	"show-ref",
	"status",
	"symbolic-ref",
	"update-index",
	"update-ref",
	"worktree",
	"write-tree",
]);

/** Section and name compare case-insensitively, a subsection exactly, as git reads config keys. */
function configKey(key: string): string {
	const parts = key.split(".");
	if (parts.length < 2) return key;
	const section = parts[0]?.toLowerCase() ?? "";
	const name = parts[parts.length - 1]?.toLowerCase() ?? "";
	return [section, ...parts.slice(1, -1), name].join(".");
}

const keySet = (keys: readonly string[]): Set<string> => new Set(keys.map(configKey));
const CALLER_C_KEYS = keySet([
	"maintenance.auto",
	"gc.auto",
	"user.name",
	"user.email",
	"core.autocrlf",
	"log.showRoot",
	"core.quotePath",
	"log.showSignature",
	"log.follow",
]);
const CONFIG_KEYS = keySet([
	"omo.agentId",
	"user.name",
	"user.email",
	"commit.gpgsign",
	"gc.auto",
	"core.autocrlf",
	"omo.memoryRepository.url",
	"omo.sync.binding",
	"omo.sync.space",
]);

/** The typed path arguments of an admitted git call, or a refusal naming what is not admitted. */
function subcommandArgs(sub: string, rest: readonly string[]): readonly TypedPath[] | string {
	if (sub === "config") {
		const [scope, first, second, extra] = rest;
		if (scope !== "--local" || first === undefined || extra !== undefined) return "config shape";
		const key = first === "--get" || first === "--unset-all" ? second : first;
		if (key === undefined || (first !== "--get" && first !== "--unset-all" && (second ?? "-").startsWith("-")))
			return "config shape";
		return CONFIG_KEYS.has(configKey(key)) ? [] : `config key ${key}`;
	}
	return matchShape(sub, rest) ?? `${sub} shape`;
}

function planGit(argv: readonly string[]): { argv: string[]; paths: readonly TypedPath[] } | string {
	let index = 0;
	while (argv[index]?.startsWith("-")) {
		const arg = argv[index] ?? "";
		if (arg === "--literal-pathspecs") {
			index++;
			continue;
		}
		if (arg !== "-c") return arg;
		const setting = argv[index + 1] ?? "";
		const separator = setting.indexOf("=");
		if (separator <= 0 || !CALLER_C_KEYS.has(configKey(setting.slice(0, separator)))) return `-c ${setting}`;
		index += 2;
	}
	const sub = argv[index];
	if (sub === undefined || !SUBCOMMANDS.has(sub)) return `subcommand ${sub ?? "(none)"}`;
	const paths = subcommandArgs(sub, argv.slice(index + 1));
	return typeof paths === "string" ? paths : { argv: [...HAND_GIT_PREFIX, ...argv], paths };
}

const equal = (args: readonly string[], expected: readonly string[]): boolean =>
	args.length === expected.length && args.every((arg, index) => arg === expected[index]);

function planLsof(argv: readonly string[], uid: number): string[] | string {
	const holders = argv.length === 3 && argv[0] === "-t" && argv[1] === "--" && (argv[2] ?? "").length > 0;
	const inUse = equal(argv, ["-w", "-a", "-d", "cwd", "-u", String(uid), "-Fpn"]);
	return holders || inUse ? [...argv] : "lsof shape";
}

const CALLER_ENV: Readonly<Record<string, (value: string) => boolean>> = {
	GIT_TERMINAL_PROMPT: (value) => value === "0",
	GIT_INDEX_FILE: (value) => value.length > 0,
	GIT_GLOB_PATHSPECS: (value) => value === "0" || value === "1",
	GIT_AUTHOR_NAME: () => true,
	GIT_AUTHOR_EMAIL: () => true,
	GIT_COMMITTER_NAME: () => true,
	GIT_COMMITTER_EMAIL: () => true,
};

const WIN32_BASELINE = ["SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PATHEXT"];

function baseline(context: HandRunContext): Record<string, string> {
	const env: Record<string, string> = {};
	const keep = (key: string): void => {
		const value = context.ownEnv[key];
		if (value !== undefined) env[key] = value;
	};
	for (const key of ["PATH", "HOME", "SSH_AUTH_SOCK"]) keep(key);
	if (context.platform === "win32") for (const key of WIN32_BASELINE) keep(key);
	else {
		keep("TMPDIR");
		env.LANG = "C";
	}
	env.GIT_PROTOCOL_FROM_USER = "0";
	return env;
}

/** Turns a `run` request into the exact argv and environment the hand spawns, or a refusal naming what was refused. */
export function planRun(request: RunRequest, context: HandRunContext): RunPlan {
	const env = baseline(context);
	for (const [key, value] of Object.entries(request.env)) {
		const allowed = Object.hasOwn(CALLER_ENV, key) ? CALLER_ENV[key] : undefined;
		if (allowed === undefined || !allowed(value))
			return { ok: false, reason: `not in the run allowlist: env ${key}` };
		env[key] = value;
	}
	const planned =
		request.exe === "git"
			? planGit(request.argv)
			: request.exe === "lsof"
				? planLsof(request.argv, context.uid)
				: `executable ${request.exe}`;
	if (typeof planned === "string") return { ok: false, reason: `not in the run allowlist: ${planned}` };
	return Array.isArray(planned)
		? { ok: true, exe: "lsof", argv: planned, env, paths: [] }
		: { ok: true, exe: "git", argv: planned.argv, env, paths: planned.paths };
}

const SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/;

/** The POSIX-quoted command line the hand's `tool_call` handlers judge: exactly what is spawned, no shell involved. */
export function renderCommand(exe: string, argv: readonly string[]): string {
	return [exe, ...argv].map((arg) => (SAFE.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ");
}
