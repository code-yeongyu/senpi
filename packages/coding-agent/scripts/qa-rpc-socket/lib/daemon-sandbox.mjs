/**
 * The throwaway world one compiled daemon is driven in: an agent directory nothing else shares, a
 * launch spec with the probe extension the session-identity cells read, a mock provider so no
 * session ever reaches a real one, and the `pi host ...` invocation that answers one JSON line.
 *
 * The daemon is started by SPAWNING the binary, never in-process: the contract under test is a
 * process contract, and the environment the daemon is granted is one of its inputs - inheriting
 * this runner's own would make the launch spec meaningless.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Publishes the per-session identity the host injected into THIS extension instance. */
const PROBE_EXTENSION = `export default function (pi) {
	pi.rpc.handle("probe.identity", () => ({ kind: pi.sessionKind, context: pi.sessionContext }));
}
`;

/**
 * Creates the sandbox and answers its paths plus `host(binary, args)`.
 *
 * The root is short on purpose: a generation handoff binds `<socket>.next-<generation>`, which must
 * stay inside the 104-byte `sun_path` limit. It is also REAL: the host reports the resolved path of
 * every session file it holds, so a sandbox under a symlinked `/tmp` would make a caller's own
 * paths compare unequal to the host's.
 */
export function createDaemonSandbox() {
	const root = realpathSync(mkdtempSync("/tmp/dh-ip-"));
	const paths = {
		root,
		agentDir: join(root, "a"),
		specDir: join(root, "spec"),
		sessionDir: join(root, "s"),
		handoffDir: join(root, "h"),
		buildDir: join(root, "b"),
		cwd: join(root, "w"),
		socket: join(root, "r.sock"),
		spec: join(root, "spec", "launch.json"),
	};
	for (const key of ["agentDir", "specDir", "sessionDir", "handoffDir", "cwd"]) {
		mkdirSync(paths[key], { recursive: true });
	}
	writeFileSync(join(paths.specDir, "probe.mjs"), PROBE_EXTENSION);
	writeFileSync(paths.spec, `${JSON.stringify(launchSpec())}\n`, { mode: 0o600 });
	return {
		...paths,
		host: (binary, args) => runHostCommand(binary, args, paths),
		remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	};
}

/** What the daemon is asked to be: one in-process multi-session host carrying the probe extension. */
function launchSpec() {
	return {
		spec_version: 1,
		core: { session_runtime: "in-process", multi_session: true, extensions: ["probe.mjs"] },
		tunables: { idleExitMs: 600_000 },
		env: { SENPI_QA_INPROCESS_DAEMON: "1" },
	};
}

/** Runs `pi host <args>` from one compiled generation and answers its single JSON line. */
function runHostCommand(binary, args, paths) {
	const result = spawnSync(binary, ["host", ...args, "--socket", paths.socket], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			TMPDIR: "/tmp",
			SENPI_CODING_AGENT_DIR: paths.agentDir,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
		},
		encoding: "utf8",
	});
	const line = (result.stdout ?? "").split("\n").find((entry) => entry.length > 0);
	if (line === undefined) throw new Error(`host ${args.join(" ")} printed no JSON line: ${result.stderr}`);
	return { exitCode: result.status, json: JSON.parse(line), stderr: result.stderr };
}
