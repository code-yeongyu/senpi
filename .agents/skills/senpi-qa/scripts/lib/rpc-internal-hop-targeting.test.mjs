import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { locateHop, stopSupervisor } from "../scenarios/rpc-internal-hop-qa.mjs";

// A fake supervised host: this process stands in for the supervisor and spawns one host child whose command line
// carries `--listen unix://<hop>/host.sock`, like the real host. It answers "ping" with "pong" over IPC, so a test can
// prove it is alive without a timer. The child exits when its supervisor is gone.
const FAKE_HOST = `
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [hop] = process.argv.slice(1);
mkdirSync(hop, { recursive: true });
writeFileSync(join(hop, ".owner"), JSON.stringify({ pid: process.pid }));
writeFileSync(join(hop, "host.sock"), "");
const watch = "const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(0); }, 100);";
const child = spawn(process.execPath, ["-e", watch, "--", "--listen", "unix://" + join(hop, "host.sock")], { stdio: "ignore" });
process.on("message", (m) => { if (m === "ping") process.send("pong"); });
process.send({ child: child.pid });
`;

async function startFakeHost(hop, socket) {
	// The socket path is on the command line, as the real supervisor's --socket is.
	const supervisor = spawn(process.execPath, ["-e", FAKE_HOST, hop, "--socket", socket], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const [ready] = await once(supervisor, "message");
	return { supervisor, childPid: ready.child };
}

/** Resolves "alive" when the process answers a ping, "exited" when it exits first. No timer decides. */
function aliveOrExited(proc) {
	if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve("exited");
	return new Promise((resolve) => {
		proc.once("exit", () => resolve("exited"));
		proc.once("message", (m) => m === "pong" && resolve("alive"));
		try {
			proc.send("ping");
		} catch {
			resolve("exited");
		}
	});
}

// 2026-10-22 incident: the hop QA driver picked the first senpi-rpc-host-internal-* directory in shared /tmp that a
// live process listened on and SIGKILLed that FOREIGN supervisor. The driver's targeting and cleanup must touch only the
// host its own `host ensure` returned. `fakeTmp` stands in for the shared /tmp, so no real host is ever scanned.
test("hop QA targeting leaves a foreign host alive and stops only its own", { skip: process.platform === "win32" }, async (t) => {
	const fakeTmp = mkdtempSync(join(tmpdir(), "hopqa-shared-tmp-"));
	const sandbox = mkdtempSync(join(tmpdir(), "hopqa-sandbox-"));
	const sandboxTmp = join(sandbox, "t");
	mkdirSync(sandboxTmp);
	const foreign = await startFakeHost(join(fakeTmp, "senpi-rpc-host-internal-f0reign1"), join(fakeTmp, "foreign.sock"));
	const owned = await startFakeHost(join(sandboxTmp, "senpi-rpc-host-internal-0wned001"), join(sandbox, "h.sock"));
	t.after(() => {
		for (const { supervisor } of [foreign, owned]) if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
		rmSync(fakeTmp, { recursive: true, force: true });
		rmSync(sandbox, { recursive: true, force: true });
	});

	const ownedExit = once(owned.supervisor, "exit");
	const target = locateHop({ supervisorPid: owned.supervisor.pid, sandboxTmp, roots: [fakeTmp, sandboxTmp] });
	if (target) stopSupervisor({ supervisorPid: target.supervisorPid, sandboxPath: sandbox, signal: "SIGKILL" });

	assert.equal(await aliveOrExited(foreign.supervisor), "alive", "the foreign supervisor must survive the driver");
	assert.deepEqual(target, {
		hop: join(sandboxTmp, "senpi-rpc-host-internal-0wned001"),
		childPid: owned.childPid,
		supervisorPid: owned.supervisor.pid,
	});
	const [, signal] = await ownedExit;
	assert.equal(signal, "SIGKILL", "the driver's own supervisor is stopped");
});
