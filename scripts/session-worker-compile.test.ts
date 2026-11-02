import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmSyncRetry } from "./rm-sync-retry.mjs";

const client = resolve(import.meta.dir, "../packages/coding-agent/src/modes/rpc/session-worker-client.ts");
const strategies = [
	{ name: "unsplit", flags: [] },
	{ name: "split", flags: ["--splitting"] },
] as const;

for (const { name, flags } of strategies) {
	test(`two live workers exchange shared memory when the ${name} production client is compiled and relocated`, () => {
		const scratch = mkdtempSync(join(tmpdir(), "senpi-compiled-worker-"));
		try {
			// Given: the real constructor and a worker that holds its isolate alive until close.
			const root = join(scratch, "source");
			mkdirSync(root);
			const entry = join(root, "entry.ts");
			const worker = join(root, "session-worker.ts");
			writeFileSync(worker, `import assert from "node:assert/strict";
import { parentPort, threadId } from "node:worker_threads";
const port = parentPort;
assert(port);
port.once("message", () => {
  const signal = new SharedArrayBuffer(4);
  const state = new Int32Array(signal);
  port.postMessage({type: "control_done", control: "cancel_ui", threadId, signal});
  assert.notEqual(Atomics.wait(state, 0, 0, 5000), "timed-out");
  const value = Atomics.load(state, 0);
  port.once("message", (message) => {
    assert.equal(message.type, "close");
    port.close();
  });
  port.postMessage({type: "control_done", control: "cancel_ui", threadId, value});
});`);
			writeFileSync(entry, `import assert from "node:assert/strict";
import { once } from "node:events";
import { SessionWorkerClient } from ${JSON.stringify(client)};
const failure = Promise.withResolvers<never>();
const clients = [1, 2].map(() => new SessionWorkerClient({
  reserve: () => "granted", reconcile: () => {}, exit: () => {},
  failure: (error) => failure.reject(new Error(error)),
}));
let closing = false;
const signal = AbortSignal.timeout(5000);
// Arm every error/exit/message observer before the first postMessage.
const exits = clients.map(({worker}) => new Promise<number>((resolve) => {
  worker.once("error", failure.reject);
  worker.once("exit", (code) => {
    if (!closing) failure.reject(new Error("worker exited before shared-memory round-trip"));
    resolve(code);
  });
}));
const ready = clients.map(({worker}) => once(worker, "message", {signal}));
try {
  for (const {worker} of clients) worker.postMessage("start");
  const messages = await Promise.race([Promise.all(ready), failure.promise]);
  const threadIds = messages.map(([message]) => message.threadId);
  assert.equal(new Set(threadIds).size, 2);
  assert(clients.every(({worker}, index) => worker.threadId > 0 && worker.threadId === threadIds[index]));
  const replies = clients.map(({worker}) => once(worker, "message", {signal}));
  for (const [index, [message]] of messages.entries()) {
    assert(message.signal instanceof SharedArrayBuffer);
    const state = new Int32Array(message.signal);
    Atomics.store(state, 0, 41 + index);
    Atomics.notify(state, 0);
  }
  const acknowledgments = await Promise.race([Promise.all(replies), failure.promise]);
  assert.deepEqual(acknowledgments.map(([message]) => message.threadId), threadIds);
  const sharedValues = acknowledgments.map(([message]) => message.value);
  assert.deepEqual(sharedValues, [41, 42]);
  closing = true;
  await Promise.race([Promise.all(clients.map((client) => client.close(1000))), failure.promise]);
  const exitCodes = await Promise.all(exits);
  assert.deepEqual(exitCodes, [0, 0]);
  console.log(JSON.stringify({workers: threadIds.length, sharedValues, exitCodes}));
} finally {
  await Promise.all(clients.map((client) => client.close(0)));
}`);
			const filename = process.platform === "win32" ? "senpi.exe" : "senpi";
			const binary = join(scratch, filename);
			const built = spawnSync(process.execPath, [
				"build", "--compile", ...flags, "--minify", "--keep-names", entry, worker, `--root=${root}`,
				'--define=SENPI_RPC_SESSION_WORKER_ENTRY="./session-worker.js"', "--outfile", binary,
			], { cwd: root, encoding: "utf8", timeout: 30_000 });
			expect(built.status, built.stderr).toBe(0);
			console.log(JSON.stringify({
				strategy: name, bun: Bun.version, revision: Bun.revision, platform: process.platform, arch: process.arch,
				clientSha256: createHash("sha256").update(readFileSync(client)).digest("hex"),
				binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
			}));
			// When: the compiled process has neither its build tree nor its original cwd.
			const relocated = join(scratch, "relocated");
			mkdirSync(relocated);
			const moved = join(relocated, filename);
			renameSync(binary, moved);
			rmSync(root, { recursive: true });
			const result = spawnSync(moved, [], {
				cwd: relocated, encoding: "utf8", timeout: 10_000,
				env: {
					PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: relocated, USERPROFILE: relocated,
					SENPI_CODING_AGENT_DIR: join(relocated, "agent"), PI_OFFLINE: "1",
				},
			});
			// Then: observe protocol values and native exits, not a success-looking log line.
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ workers: 2, sharedValues: [41, 42], exitCodes: [0, 0] });
		} finally {
			// Windows can hold a file the relocated workers just used; teardown must not decide the result (senpi#2657).
			const cleanup = rmSyncRetry(scratch);
			if (!cleanup.removed) console.warn(`left scratch directory ${scratch}: ${String(cleanup.error)}`);
		}
	}, 45_000);
}
