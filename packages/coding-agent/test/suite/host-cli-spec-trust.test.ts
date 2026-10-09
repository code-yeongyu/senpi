/**
 * What `senpi host` refuses to act on: an unusable command line, an untrustworthy launch spec, and
 * a running host this build may not replace.
 *
 * The launch spec decides what code a long-lived machine-wide daemon LOADS, so each refusal below
 * is proven twice: the typed reason on stdout with exit 2, AND the absence of a daemon. A spec that
 * is rejected after a host was already started would have defeated the check it passed.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../src/config.ts";
import { processAlive } from "../helpers/spawned-host-reaper.ts";
import {
	daemonEnvironmentText,
	type HostCliSandbox,
	hostCliSandbox,
	onlyJsonLine,
	runHostCli,
	startFixtureHost,
	sweepHostCliSandboxes,
} from "./host-cli-support.ts";

/** A host that serves every client need EXCEPT the drain a generation handoff is built on. */
const NO_HANDOFF_CAPABILITIES = "multi_session,extension_events,session_context,session_kind";

afterEach(async () => {
	await sweepHostCliSandboxes();
}, 120_000);

describe("senpi host command line", () => {
	it("answers an unknown subcommand with usage on stderr and nothing on stdout", async () => {
		const qa = await hostCliSandbox("usage");

		const result = await runHostCli(qa, ["frob"]);

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("host <ensure|status|stop|handoff|shard-path|gc>");
	}, 60_000);

	it("answers an unknown option with usage on stderr and nothing on stdout", async () => {
		const qa = await hostCliSandbox("flag");

		const result = await runHostCli(qa, ["status", "--include-zombies"]);

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--include-zombies");
	}, 60_000);
});

describe.skipIf(process.platform === "win32")("senpi host launch spec trust", () => {
	it("refuses a spec anyone can rewrite", async () => {
		const qa = await hostCliSandbox("insecure");
		const spec = await writeSpec(qa, { spec_version: 1, core: CORE, tunables: {}, env: {} }, 0o666);

		await expectRefusal(qa, spec, "launch_spec_insecure");
	}, 60_000);

	it("refuses an extension path that leaves the spec directory", async () => {
		const qa = await hostCliSandbox("escape");
		const spec = await writeSpec(qa, {
			spec_version: 1,
			core: { ...CORE, extensions: ["../evil.js"] },
		});

		await expectRefusal(qa, spec, "launch_spec_path_escape");
	}, 60_000);

	it("refuses an env key outside the brand's own lane", async () => {
		const qa = await hostCliSandbox("env");
		const spec = await writeSpec(qa, { spec_version: 1, core: CORE, env: { PATH: "/tmp/evil" } });

		await expectRefusal(qa, spec, "launch_spec_env_denied");
	}, 60_000);

	it("refuses to start half a profile when a listed extension is missing", async () => {
		const qa = await hostCliSandbox("missing");
		const spec = await writeSpec(qa, {
			spec_version: 1,
			core: { ...CORE, extensions: ["probe.js"] },
		});

		await expectRefusal(qa, spec, "launch_spec_missing_extension");
	}, 60_000);

	it("starts a daemon whose launch profile carries the spec's own extensions", async () => {
		const qa = await hostCliSandbox("profile");
		const extension = join(qa.specDir, "nested", "probe.js");
		await mkdir(join(qa.specDir, "nested"), { recursive: true });
		await writeFile(extension, "export default function probe() {}\n");
		const spec = await writeSpec(qa, {
			spec_version: 1,
			core: { ...CORE, extensions: ["nested/probe.js"] },
			tunables: { idleExitMs: 600_000, coldStart: "transient" },
		});

		const result = await runHostCli(qa, ["ensure", "--json", "--launch-spec", spec]);

		expect(result.exitCode).toBe(0);
		expect(onlyJsonLine(result)).toMatchObject({ action: "start" });
		const status = onlyJsonLine(await runHostCli(qa, ["status", "--json"]));
		expect((status.launchProfile as { core: { extensions: string[] } }).core.extensions).toEqual([
			await realpath(extension),
		]);
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("senpi host handoff", () => {
	it("starts one sanitized successor generation", async () => {
		const qa = await hostCliSandbox("successor-env");
		const first = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));

		const result = await runHostCli(qa, ["handoff", "--json"], {
			PI_SESSION_ID: "session-2208",
			PI_SESSION_FILE: "/tmp/session-2208.jsonl",
			SENPI_PY_KERNEL_PARENT_PID: "2208",
		});

		expect(result.exitCode).toBe(0);
		const successor = onlyJsonLine(result);
		expect(successor).toMatchObject({ action: "handoff", generation: 1, reused: false });
		expect(successor.pid).not.toBe(first.pid);
		const environment = daemonEnvironmentText(successor.pid as number);
		expect(environment).not.toContain("PI_SESSION_ID");
		expect(environment).not.toContain("PI_SESSION_FILE");
		expect(environment).not.toContain("SENPI_PY_KERNEL_PARENT_PID");
	}, 180_000);

	it("refuses against a host that cannot drain, and leaves it running", async () => {
		const qa = await hostCliSandbox("legacy");
		const fixturePid = await startFixtureHost(qa, VERSION, NO_HANDOFF_CAPABILITIES);

		const result = await runHostCli(qa, ["handoff", "--json"]);

		expect(result.exitCode).toBe(3);
		expect(onlyJsonLine(result)).toMatchObject({
			action: "refuse",
			reason: "upgrade_unsupported",
			detail: "handoff_unsupported",
		});
		expect(processAlive(fixturePid)).toBe(true);
	}, 60_000);
});

const CORE = { session_runtime: "in-process", multi_session: true, extensions: [] } as const;

async function writeSpec(qa: HostCliSandbox, spec: unknown, mode = 0o600): Promise<string> {
	const path = join(qa.specDir, "launch.json");
	await writeFile(path, `${JSON.stringify(spec)}\n`);
	// The mode is what the trust check reads, and `writeFile`'s own is masked by the umask.
	await chmod(path, mode);
	return path;
}

/** Every spec refusal is exit 2 with its typed reason - and no daemon on the socket. */
async function expectRefusal(qa: HostCliSandbox, spec: string, reason: string): Promise<void> {
	const result = await runHostCli(qa, ["ensure", "--json", "--launch-spec", spec]);

	expect(result.exitCode).toBe(2);
	expect(onlyJsonLine(result)).toMatchObject({ action: "error", reason });
	expect(existsSync(qa.socket)).toBe(false);
}
