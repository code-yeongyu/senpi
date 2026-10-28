import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { INTERNAL_HANDOFF_ENV_NAMES } from "./rpc-host-spawn-env.ts";

const testRoot = join(import.meta.dirname, "..");
const launchSource = join(testRoot, "..", "src", "modes", "rpc", "host-lifecycle-launch.ts");

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
		const written = [...spawnChild.matchAll(/\[([A-Z][A-Z0-9_]*_ENV)\]:/gu)].map((match) => match[1]);
		expect(written.length).toBeGreaterThan(5);

		// The launch writes each name through its imported constant; this list must hold the same values.
		const carried = new Set(INTERNAL_HANDOFF_ENV_NAMES);
		const missing = written.filter((name) => {
			const declaration = new RegExp(`export const ${name} = "([^"]+)"`, "u");
			const value = [
				"src/modes/rpc/host-daemon-paths.ts",
				"src/modes/rpc/host-identity-env.ts",
				"src/modes/rpc/host-watchdog.ts",
				"src/modes/rpc/host-lifetime-binding.ts",
				"src/modes/rpc/socket-transport.ts",
				"src/modes/rpc/internal-key-env.ts",
			]
				.map((path) => declaration.exec(readFileSync(join(testRoot, "..", path), "utf8"))?.[1])
				.find((found) => found !== undefined);
			return value !== undefined && !carried.has(value);
		});

		expect(missing).toEqual([]);
	});

	it("is dropped by the daemon environment allowlist too, so an ensured host cannot inherit it", () => {
		const allowlist = readFileSync(join(testRoot, "..", "src/modes/rpc/host-daemon-env.ts"), "utf8");
		const transient = allowlist.slice(allowlist.indexOf("const TRANSIENT_ENV_NAMES"));
		const dropped = new Set(
			[...transient.slice(0, transient.indexOf("]);")).matchAll(/"([A-Z][A-Z0-9_]*)"/gu)].map((m) => m[1]),
		);

		expect(INTERNAL_HANDOFF_ENV_NAMES.filter((name) => !dropped.has(name))).toEqual([]);
	});
});
