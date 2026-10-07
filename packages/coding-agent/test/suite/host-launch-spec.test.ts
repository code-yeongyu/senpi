/**
 * The launch spec as a value: what it parses into, what it refuses, and which environment names a
 * daemon built from it is allowed to see.
 *
 * These are the edge classes the CLI cases cannot reach cheaply - a symlinked escape, a win32
 * environment that is case-insensitive and needs `SystemRoot`, a spec version from the future.
 */
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	daemonEnvIsAllowed,
	daemonEnvironment,
	daemonEnvKeys,
	daemonEnvOverrides,
} from "../../src/modes/rpc/host-daemon-env.ts";
import { HostLaunchSpecError, loadHostLaunchSpec, parseHostLaunchSpec } from "../../src/modes/rpc/host-launch-spec.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const CORE = { session_runtime: "in-process", multi_session: true, extensions: [] };

describe("parseHostLaunchSpec", () => {
	it("keeps a well-formed spec's core, tunables and env", () => {
		const spec = parseHostLaunchSpec(
			JSON.stringify({
				spec_version: 1,
				core: { ...CORE, extensions: ["a.js"] },
				tunables: { idleExitMs: 1_000, coldStart: "persistent" },
				env: { SENPI_X: "1" },
			}),
		);

		expect(spec.core).toEqual({ session_runtime: "in-process", multi_session: true, extensions: ["a.js"] });
		expect(spec.tunables).toEqual({ idleExitMs: 1_000, coldStart: "persistent" });
		expect(spec.env).toEqual({ SENPI_X: "1" });
	});

	it.each([
		["a version from the future", { spec_version: 2, core: CORE }],
		["a core that is not an object", { spec_version: 1, core: "in-process" }],
		["an unknown session runtime", { spec_version: 1, core: { ...CORE, session_runtime: "threads" } }],
		["a single-session daemon", { spec_version: 1, core: { ...CORE, multi_session: false } }],
		["extensions that are not strings", { spec_version: 1, core: { ...CORE, extensions: [7] } }],
		["an env value that is not a string", { spec_version: 1, core: CORE, env: { SENPI_X: 7 } }],
	])("refuses %s", (_case, document) => {
		expect(refusalOf(() => parseHostLaunchSpec(JSON.stringify(document)))).toBe("launch_spec_invalid");
	});

	it("refuses text that is not JSON", () => {
		expect(() => parseHostLaunchSpec("not json")).toThrow(HostLaunchSpecError);
	});
});

describe.skipIf(process.platform === "win32")("loadHostLaunchSpec", () => {
	it("turns the spec into host arguments with absolute extension paths", async () => {
		const root = await scratch();
		await writeFile(`${root}/probe.js`, "export default function probe() {}\n");
		const path = await spec(root, {
			spec_version: 1,
			core: { ...CORE, extensions: ["probe.js"] },
			tunables: { idleExitMs: 5_000 },
		});

		const resolved = await loadHostLaunchSpec(path);

		expect(resolved.hostArgs).toEqual(["--session-runtime", "in-process", "--extension", `${root}/probe.js`]);
		expect(resolved.policy).toEqual({ idleExitMs: 5_000 });
	});

	it("refuses an extension that is inside the spec directory but LINKS outside it", async () => {
		const root = await scratch();
		const outside = await scratch();
		await writeFile(`${outside}/evil.js`, "export default function evil() {}\n");
		await symlink(`${outside}/evil.js`, `${root}/probe.js`);
		const path = await spec(root, { spec_version: 1, core: { ...CORE, extensions: ["probe.js"] } });

		await expect(loadHostLaunchSpec(path)).rejects.toMatchObject({ reason: "launch_spec_path_escape" });
	});
});

describe("daemon environment scope", () => {
	it("drops every name outside the allowlist and keeps the ones a daemon needs", () => {
		const overrides = daemonEnvOverrides(
			{ PATH: "/bin", HOME: "/home/x", MY_SECRET_TOKEN: "canary", ANTHROPIC_API_KEY: "k", DATABASE_URL: "postgres" },
			{},
			"linux",
		);

		expect(overrides).toEqual({ MY_SECRET_TOKEN: null, DATABASE_URL: null });
	});

	it("drops session, kernel, and inherited host identity from the daemon environment", () => {
		const transient = {
			PI_SESSION_ID: "session-2208",
			PI_SESSION_FILE: "/tmp/session-2208.jsonl",
			PI_SESSION_CWD: "/tmp/worktree",
			PI_GOAL_STORE_FILE: "/tmp/goals/session-2208.json",
			PI_PROVIDER: "fake",
			PI_MODEL: "fake-model",
			PI_REASONING_LEVEL: "high",
			PI_PROMPT_CACHE_SAFE_WAIT_SECONDS: "1770",
			SENPI_PY_KERNEL_PARENT_PID: "2208",
			SENPI_RPC_HOST_WATCH_FD: "19",
			SENPI_RPC_HOST_WATCH_PPID: "2207",
			SENPI_RPC_HOST_SCRATCH_DIR: "/tmp/old-host",
			SENPI_RPC_HOST_CLEANUP_PATHS: "/tmp/old-host/a",
			SENPI_RPC_HOST_PUBLIC_SOCKET: "/tmp/old-host.sock",
			SENPI_RPC_HOST_INSTANCE_ID: "old-instance",
			SENPI_RPC_HOST_GENERATION: "7",
			SENPI_RPC_HOST_DAEMON_DIR: "/tmp/old-daemon",
		};

		const overrides = daemonEnvOverrides(
			{
				PATH: "/bin",
				SENPI_RPC_HOST_RSS_WARN_MB: "2048",
				SENPI_ENABLE_GROK_NEO: "1",
				...transient,
			},
			Object.fromEntries(Object.keys(transient).map((name) => [name, "explicit-attempt"])),
			"linux",
		);

		expect(overrides).toEqual(Object.fromEntries(Object.keys(transient).map((name) => [name, null])));
		expect(
			daemonEnvKeys(transient, Object.fromEntries(Object.keys(transient).map((name) => [name, "explicit-attempt"]))),
		).toEqual([]);
	});

	it("lets the spec add to the environment it was granted", () => {
		const overrides = daemonEnvOverrides({ PATH: "/bin", CI: "1" }, { SENPI_X: "on" }, "linux");

		expect(overrides).toEqual({ CI: null, SENPI_X: "on" });
		expect(daemonEnvKeys({ PATH: "/bin", CI: "1" }, { SENPI_X: "on" }, "linux")).toEqual(["PATH", "SENPI_X"]);
	});

	it("replaces a win32 environment name case-insensitively", () => {
		expect(daemonEnvironment({ Path: "C:\\old" }, { PATH: "C:\\new" }, {}, "win32")).toEqual({
			PATH: "C:\\new",
		});
	});

	it.each([
		["Path", "linux", false],
		["Path", "win32", true],
		["SystemRoot", "linux", false],
		["SystemRoot", "win32", true],
		["OPENAI_API_KEY", "linux", true],
		["SENPI_RPC_SOCKET", "linux", true],
		["AWS_PROFILE", "linux", true],
		["NODE_OPTIONS", "linux", false],
	])("%s on %s is allowed: %s", (name, platform, allowed) => {
		expect(daemonEnvIsAllowed(name, platform as NodeJS.Platform)).toBe(allowed);
	});
});

/** Real paths on purpose: the spec resolves extensions through `realpath`, and macOS temp is a symlink. */
async function scratch(): Promise<string> {
	const root = await mkdtemp(`${tmpdir()}/hs-`);
	roots.push(root);
	return realpath(root);
}

function refusalOf(action: () => unknown): string {
	try {
		action();
	} catch (error: unknown) {
		if (error instanceof HostLaunchSpecError) return error.reason;
		throw error;
	}
	throw new Error("expected a launch spec refusal");
}

async function spec(root: string, document: unknown): Promise<string> {
	const path = `${root}/launch.json`;
	await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
	return path;
}
