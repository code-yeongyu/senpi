import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonEnvIsAllowed } from "../../src/modes/rpc/host-daemon-env.ts";
import * as hostDaemonPaths from "../../src/modes/rpc/host-daemon-paths.ts";
import * as hostIdentityEnv from "../../src/modes/rpc/host-identity-env.ts";
import * as hostLifetimeBinding from "../../src/modes/rpc/host-lifetime-binding.ts";
import * as hostWatchdog from "../../src/modes/rpc/host-watchdog.ts";
import * as socketTransport from "../../src/modes/rpc/socket-transport.ts";
import { INTERNAL_HANDOFF_ENV_NAMES } from "./rpc-host-spawn-env.ts";

/**
 * The modules that DECLARE an env-name constant the host-child launch writes. The guard resolves
 * each written identifier through these RUNTIME exports rather than by reading their source: a
 * value built from a template (`INTERNAL_KEY_STDIN_ENV`) is invisible to a source-text regex, and a
 * name whose value cannot be read would otherwise be silently treated as covered (senpi#4618).
 */
const ENV_CONSTANT_MODULES: readonly Record<string, unknown>[] = [
	hostDaemonPaths,
	hostIdentityEnv,
	hostLifetimeBinding,
	hostWatchdog,
	socketTransport,
];

/** The value of an exported env-name constant, or `undefined` when no module exports that name. */
function envConstantValue(name: string): string | undefined {
	for (const module of ENV_CONSTANT_MODULES) {
		const value = module[name];
		if (typeof value === "string") return value;
	}
	return undefined;
}

const testRoot = join(import.meta.dirname, "..");
const launchSource = join(testRoot, "..", "src", "modes", "rpc", "host-lifecycle-launch.ts");

/**
 * Names the host-child launch may write as a PLAIN key without carrying them in the hand-off list.
 * Each row states why the spawned child is meant to keep that variable; anything else the launch
 * writes - in any key shape - must be in `INTERNAL_HANDOFF_ENV_NAMES`, so a lane added as a bare
 * literal (`SENPI_RPC_HOST_NEW_LANE: "x"`) fails this guard instead of slipping past a regex that
 * only reads computed `[CONSTANT]:` keys (senpi#4618).
 */
const LAUNCH_ENV_KEY_EXEMPTIONS: readonly { readonly name: string; readonly reason: string }[] = [
	{
		name: "SENPI_CODING_AGENT_DIR",
		reason: "the agent directory the child must claim; configuration the child keeps, not a supervisor hand-off",
	},
];

/** `source` with its line comments removed, so a commented-out key is never collected as written. */
function withoutLineComments(source: string): string {
	return source.replaceAll(/^[ \t]*\/\/[^\n]*\n/gmu, "").replaceAll(/\/\/[^\n]*/gu, "");
}

/**
 * The `env` object literal `spawnHostChild` builds, brace-matched from its `env: {`. Reading the
 * whole function instead would collect the `stdio` block and the launch's own locals.
 */
function launchEnvLiteral(launchFunction: string): string {
	const start = launchFunction.indexOf("env: {");
	if (start < 0) throw new Error("spawnHostChild no longer builds its child environment as an `env` object literal");
	let depth = 0;
	for (let index = start; index < launchFunction.length; index += 1) {
		const character = launchFunction[index];
		if (character === "{") depth += 1;
		if (character === "}") {
			depth -= 1;
			if (depth === 0) return launchFunction.slice(start, index + 1);
		}
	}
	throw new Error("spawnHostChild's `env` object literal is unterminated");
}

/**
 * Every key the launch's `env` literal writes, in EVERY shape it can take: a computed
 * `[CONSTANT]:` key (reported as the identifier), a plain or quoted `NAME:` key, and a `NAME,`
 * shorthand - at the literal's top level and inside the conditional spreads nested in it. A key is
 * only ever preceded by `{` or `,`, which is what separates it from a value of the same spelling.
 */
function launchEnvKeys(envLiteral: string): { readonly computed: string[]; readonly literal: string[] } {
	const source = withoutLineComments(envLiteral);
	const computed = [...source.matchAll(/\[\s*([A-Za-z_$][\w$]*)\s*\]\s*:/gu)].map((match) => match[1] ?? "");
	const literal = [...source.matchAll(/[{,]\s*"?([A-Z][A-Z0-9_]*)"?\s*[:,}]/gu)].map((match) => match[1] ?? "");
	return { computed, literal: [...new Set(literal)] };
}

/**
 * Files that spawn a senpi CLI, host or supervisor. Each one inherits this process's environment,
 * so each must build the child's environment with `hostSpawnEnv()` rather than `process.env`:
 * a runner that is itself a host child otherwise hands the spawned host its supervisor's lane.
 */
const HOST_SPAWNING_SOURCES = [
	{
		dir: ".",
		pattern: /^(rpc-host-|session-|startup-|stdout-|cli-inprocess|experimental-cli|interactive-w3|valid-cwd)/u,
	},
	{ dir: "helpers", pattern: /^rpc-/u },
	{ dir: "suite", pattern: /^(rpc-|schedule-cli)/u },
	{ dir: "suite/regressions", pattern: /(rpc|host|session|cli|inspector|supervisor)/u },
] as const;

/**
 * `...process.env` that is NOT a host spawn. Each row states why the raw environment is correct
 * there; anything not listed must go through `hostSpawnEnv()`.
 */
const ALLOWED_RAW_ENV: readonly { readonly file: string; readonly reason: string }[] = [
	{
		file: "suite/rpc-host-exec-argv.test.ts",
		reason: "the spread is inside a generated child script's own source, where this helper does not exist",
	},
	{
		file: "helpers/rpc-host-spawn-env.test.ts",
		reason: "this guard names the pattern it bans",
	},
	{
		file: "suite/regressions/issue-omo-594-host-status-zero-spawn.test.ts",
		reason: "the spread is inside a fixture written to a temp directory, which cannot resolve this helper",
		// Same reason as rpc-host-exec-argv.test.ts: the generated child is run from
		// outside the package, so it builds its environment inline.
	},
];

function filesUnder(dir: string): string[] {
	const root = join(testRoot, dir);
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".ts"))
		.filter((entry) => statSync(join(root, entry)).isFile())
		.map((entry) => join(root, entry));
}

describe("a test that spawns a host builds its environment with hostSpawnEnv", () => {
	it("leaves no raw process.env spread in a host-spawning test file", () => {
		const allowed = new Set(ALLOWED_RAW_ENV.map((row) => row.file));
		const offenders = HOST_SPAWNING_SOURCES.flatMap(({ dir, pattern }) =>
			filesUnder(dir)
				.filter((path) => pattern.test(path.slice(path.lastIndexOf("/") + 1)))
				.filter((path) => readFileSync(path, "utf8").includes("...process.env"))
				.map((path) => relative(testRoot, path)),
		).filter((path) => !allowed.has(path));

		expect(offenders).toEqual([]);
	});

	it("carries every variable the supervisor's own host-child launch writes", () => {
		const source = readFileSync(launchSource, "utf8");
		const spawnChild = source.slice(source.indexOf("export function spawnHostChild"));
		const keys = launchEnvKeys(launchEnvLiteral(spawnChild));
		const written = keys.computed;
		expect(written.length).toBeGreaterThan(5);

		// Every written identifier must resolve to a runtime value; an unresolved one is a FAILURE, not
		// a pass, because a name this guard cannot read is a name it cannot prove is carried.
		const unresolved = written.filter((name) => envConstantValue(name) === undefined);
		expect(unresolved).toEqual([]);

		// The launch writes each name through its imported constant; this list must hold the same values.
		const carried = new Set(INTERNAL_HANDOFF_ENV_NAMES);
		const missing = written.filter((name) => {
			const value = envConstantValue(name);
			return value !== undefined && !carried.has(value);
		});

		expect(missing).toEqual([]);

		// A key written as a plain literal carries no constant to resolve, so it is matched by its own
		// spelling: it must be in the hand-off list, or be an exempted name with a stated reason.
		const exempt = new Set(LAUNCH_ENV_KEY_EXEMPTIONS.map((row) => row.name));
		const uncarriedLiterals = keys.literal.filter((name) => !carried.has(name) && !exempt.has(name));

		expect(uncarriedLiterals).toEqual([]);
	});

	it.each(["linux", "darwin", "win32"] as const)(
		"is dropped by the daemon environment allowlist on %s too, so an ensured host cannot inherit it",
		(platform) => {
			// Asked of the allowlist FUNCTION, not of its source: a name added to the hand-off list but
			// never to `TRANSIENT_ENV_NAMES` fails here whatever shape the production list is written in.
			const inherited = INTERNAL_HANDOFF_ENV_NAMES.filter((name) => daemonEnvIsAllowed(name, platform));

			expect(inherited).toEqual([]);
		},
	);
});
