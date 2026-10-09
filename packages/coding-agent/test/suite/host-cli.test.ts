/**
 * `senpi host ensure|status` against a REAL daemon started by the source CLI.
 *
 * Every assertion here is made from outside the process that is being tested: the JSON line the CLI
 * printed, the exit code it returned, and - for the environment scope - the daemon's own environment
 * as the operating system reports it. Nothing is stubbed, because what is under test is precisely
 * what a client observes when it shells out to this command.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	daemonEnvironmentText,
	hostCliSandbox,
	onlyJsonLine,
	runHostCli,
	sweepHostCliSandboxes,
} from "./host-cli-support.ts";

const STATUS_FIELDS = [
	"capabilities",
	"claims",
	"claims_live",
	"crashes",
	"engineVersion",
	"env_keys",
	"generation",
	"generations",
	"handover",
	"host_rss_mb",
	"instanceId",
	"launchProfile",
	"memory_pressure",
	"open_fds",
	"pid",
	"reachable",
	"rss_mb",
	"runtimeBuildId",
	"session_rows",
	"sessions",
	"shard",
	"socket",
	"zombies",
];

const SESSION_COUNT_FIELDS = ["foreign_attached", "foreign_retained", "interactive", "retained", "total", "worker"];

afterEach(async () => {
	await sweepHostCliSandboxes();
}, 120_000);

// The daemon is a POSIX process tree with a unix socket; the win32 named-pipe cell of this
// contract runs in the platform's own CI job.
describe.skipIf(process.platform === "win32")("senpi host ensure", () => {
	it("starts a daemon when the agent directory has none", async () => {
		const qa = await hostCliSandbox("start");

		const result = await runHostCli(qa, ["ensure", "--json"]);

		expect(result.exitCode).toBe(0);
		const payload = onlyJsonLine(result);
		expect(payload).toMatchObject({ action: "start", socket: qa.socket, reused: false, upgradeable: true });
		expect(typeof payload.pid).toBe("number");
		expect(typeof payload.instanceId).toBe("string");
		expect(payload.capabilities).toContain("multi_session");
		expect(typeof payload.launchProfileId).toBe("string");
	}, 120_000);

	it("reuses the running daemon when a second ensure finds it", async () => {
		const qa = await hostCliSandbox("reuse");
		const first = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));

		const second = await runHostCli(qa, ["ensure", "--json"]);

		expect(second.exitCode).toBe(0);
		const payload = onlyJsonLine(second);
		expect(payload).toMatchObject({
			action: "reuse",
			reused: true,
			instanceId: first.instanceId,
			pid: first.pid,
		});
	}, 120_000);

	it("gives the daemon the allowlisted environment and nothing else", async () => {
		const qa = await hostCliSandbox("env");

		const ensured = onlyJsonLine(
			await runHostCli(qa, ["ensure", "--json"], {
				MY_SECRET_TOKEN: "canary-value",
				PI_SESSION_ID: "session-2208",
				PI_SESSION_FILE: "/tmp/session-2208.jsonl",
				PI_SESSION_CWD: "/tmp/worktree",
				PI_GOAL_STORE_FILE: "/tmp/goals/session-2208.json",
				PI_PROVIDER: "fake",
				PI_MODEL: "fake-model",
				PI_REASONING_LEVEL: "high",
				PI_PROMPT_CACHE_SAFE_WAIT_SECONDS: "1770",
				SENPI_PY_KERNEL_PARENT_PID: "2208",
			}),
		);

		const environment = daemonEnvironmentText(ensured.pid as number);
		expect(environment).toMatch(/\bHOME=/u);
		expect(environment).toMatch(/\bSENPI_RPC_HOST_DAEMON_DIR=/u);
		// The canary was set on the ensuring process and is outside the allowlist: the daemon that
		// outlives that process must never have been told it.
		expect(environment).not.toContain("MY_SECRET_TOKEN");
		expect(environment).not.toContain("canary-value");
		for (const name of [
			"PI_SESSION_ID",
			"PI_SESSION_FILE",
			"PI_SESSION_CWD",
			"PI_GOAL_STORE_FILE",
			"PI_PROVIDER",
			"PI_MODEL",
			"PI_REASONING_LEVEL",
			"PI_PROMPT_CACHE_SAFE_WAIT_SECONDS",
			"SENPI_PY_KERNEL_PARENT_PID",
		]) {
			expect(environment).not.toContain(`${name}=`);
		}
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("senpi host status", () => {
	it("reports the running daemon's identity, occupancy and environment scope", async () => {
		const qa = await hostCliSandbox("status");
		const ensured = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));

		const result = await runHostCli(qa, ["status", "--json"]);

		expect(result.exitCode).toBe(0);
		const status = onlyJsonLine(result);
		expect(Object.keys(status).sort()).toEqual(STATUS_FIELDS);
		expect(status).toMatchObject({
			reachable: true,
			socket: qa.socket,
			pid: ensured.pid,
			instanceId: ensured.instanceId,
			generation: 0,
		});
		expect(Object.keys(status.sessions as Record<string, unknown>).sort()).toEqual(SESSION_COUNT_FIELDS);
		expect(status.sessions).toEqual({
			total: 0,
			interactive: 0,
			worker: 0,
			retained: 0,
			foreign_attached: 0,
			foreign_retained: 0,
		});
		// Names only, and only the allowlist: a value never leaves the ensuring process.
		expect(status.env_keys).toContain("HOME");
		expect(status.env_keys).toContain("SENPI_CODING_AGENT_DIR");
		expect(status.env_keys).not.toContain("MY_SECRET_TOKEN");
		expect(status.generations).toHaveLength(1);
		const generation = (status.generations as Record<string, unknown>[])[0];
		expect(Object.keys(generation).sort()).toEqual([
			"alive",
			"current",
			"engineVersion",
			"generation",
			"host_rss_mb",
			"instanceId",
			"pid",
			"rss_mb",
			"sessions",
		]);
		expect(generation).toMatchObject({
			instanceId: ensured.instanceId,
			generation: 0,
			pid: ensured.pid,
			engineVersion: ensured.engineVersion,
			// The daemon holds nothing, so it claims no session file either.
			sessions: 0,
			current: true,
			alive: true,
		});
		// `number | null` by contract: a platform that cannot answer `ps` still reports the field.
		expect(generation.rss_mb === null || typeof generation.rss_mb === "number").toBe(true);
		expect(generation.host_rss_mb === null || typeof generation.host_rss_mb === "number").toBe(true);
	}, 120_000);

	it("answers a socket nobody serves with the same shape and a refusal code", async () => {
		const qa = await hostCliSandbox("absent");

		const result = await runHostCli(qa, ["status", "--json"]);

		expect(result.exitCode).toBe(3);
		const status = onlyJsonLine(result);
		expect(Object.keys(status).sort()).toEqual(STATUS_FIELDS);
		expect(status).toMatchObject({ reachable: false, socket: qa.socket, pid: null, generations: [] });
	}, 60_000);

	it("lists every endpoint of the agent directory under --all, ignoring --socket", async () => {
		const qa = await hostCliSandbox("all");
		const ensured = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));

		const result = await runHostCli(qa, ["status", "--all", "--json"]);

		expect(result.exitCode).toBe(0);
		const { endpoints } = onlyJsonLine(result) as { endpoints: Record<string, unknown>[] };
		expect(endpoints).toHaveLength(1);
		expect(endpoints[0]).toMatchObject({
			socket: qa.socket,
			reachable: true,
			pid: ensured.pid,
			identity: "endpoint",
			endpoint_kind: "rpc_host",
			alive: true,
			reason: null,
			shard: null,
			crashes: 0,
			session_rows: [],
			claims_live: 0,
		});
	}, 120_000);

	it("answers --all on an agent directory with no endpoints with an empty list and a refusal", async () => {
		const qa = await hostCliSandbox("all-empty");

		const result = await runHostCli(qa, ["status", "--all", "--json"]);

		expect(result.exitCode).toBe(3);
		expect(onlyJsonLine(result)).toEqual({ endpoints: [] });
	}, 60_000);
});

describe.skipIf(process.platform === "win32")("senpi host gc", () => {
	it("keeps a running daemon, and answers an empty --agent-dir with nothing, exit 0 both times", async () => {
		const qa = await hostCliSandbox("gc");
		onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));

		const live = await runHostCli(qa, ["gc", "--json"]);
		const empty = await runHostCli(qa, ["gc", "--agent-dir", qa.specDir, "--json"]);

		expect(live.exitCode).toBe(0);
		expect(onlyJsonLine(live)).toEqual({
			removed: [],
			kept: [{ socket: qa.socket, dir: expect.any(String), reason: "live_generation" }],
		});
		expect(empty.exitCode).toBe(0);
		expect(onlyJsonLine(empty)).toEqual({ removed: [], kept: [] });
	}, 120_000);

	it("refuses an unknown option with the usage exit code and no stdout", async () => {
		const qa = await hostCliSandbox("gc-usage");

		for (const flag of ["--all", "--bogus"]) {
			const result = await runHostCli(qa, ["gc", flag]);

			expect(result.exitCode).toBe(2);
			expect(result.stdout).toBe("");
		}
	}, 60_000);
});

describe("senpi host shard-path", () => {
	it("prints the naming contract's socket, as JSON under --json and bare otherwise", async () => {
		const qa = await hostCliSandbox("shard");
		const owner = ["--kind", "p", "--owner", "01a0e28d-40e4-7402-bac7-8de6e76ad84c", "--root", "/r"];

		const json = await runHostCli(qa, ["shard-path", ...owner, "--json"]);
		const bare = await runHostCli(qa, ["shard-path", ...owner]);

		expect(json.exitCode).toBe(0);
		expect(onlyJsonLine(json)).toEqual({
			kind: "p",
			key: "6d410ba846ba1550",
			socket: "/r/p-6d410ba846ba1550.sock",
		});
		expect(bare).toMatchObject({ exitCode: 0, stdout: "/r/p-6d410ba846ba1550.sock\n" });
	}, 60_000);

	it("refuses a command line without --kind and --owner", async () => {
		const qa = await hostCliSandbox("shard-usage");

		const result = await runHostCli(qa, ["shard-path", "--kind", "i"]);

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
	}, 60_000);
});
