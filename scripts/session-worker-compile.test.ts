import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const client = resolve(import.meta.dir, "../packages/coding-agent/src/modes/rpc/session-worker-client.ts");

test("#given the production SessionWorkerClient #when compiled and relocated #then two embedded workers respond", () => {
	const scratch = mkdtempSync(join(tmpdir(), "senpi-compiled-worker-"));
	try {
		// given: bundle the real constructor, not a copy of its path resolver.
		const root = join(scratch, "source");
		mkdirSync(root);
		const entry = join(root, "entry.ts");
		const worker = join(root, "session-worker.ts");
		writeFileSync(worker, `import { parentPort } from "node:worker_threads";
parentPort.once("message", () => parentPort.postMessage({type: "control_done", control: "cancel_ui"}));`);
		writeFileSync(entry, `import { SessionWorkerClient } from ${JSON.stringify(client)};
await Promise.all([1, 2].map(async () => {
  const client = new SessionWorkerClient({reserve: () => true, exit: () => {}, failure: (error) => { throw new Error(error); }});
  const ready = new Promise((resolve, reject) => {
    client.worker.once("error", reject);
    client.worker.once("message", resolve);
  });
  client.worker.postMessage("start");
  const message = await ready;
  if (message.type !== "control_done") throw new Error("Unexpected worker message");
  await client.close(0);
}));
console.log("two-production-client-workers-ready");`);
		const binary = join(scratch, process.platform === "win32" ? "senpi.exe" : "senpi");
		const built = spawnSync(process.execPath, ["build", "--compile", entry, worker, `--root=${root}`, '--define=SENPI_RPC_SESSION_WORKER_ENTRY="./session-worker.js"', "--outfile", binary], { cwd: root, encoding: "utf8", timeout: 30_000 });
		expect(built.status, built.stderr).toBe(0);
		console.log(JSON.stringify({ bun: Bun.version, revision: Bun.revision, platform: process.platform, arch: process.arch, clientSha256: createHash("sha256").update(readFileSync(client)).digest("hex"), binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex") }));
		// when: the compiled process has neither its build tree nor its original cwd.
		const relocated = join(scratch, "relocated");
		mkdirSync(relocated);
		const moved = join(relocated, process.platform === "win32" ? "senpi.exe" : "senpi");
		renameSync(binary, moved);
		rmSync(root, { recursive: true });
		const result = spawnSync(moved, [], { cwd: relocated, encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: relocated, USERPROFILE: relocated, SENPI_CODING_AGENT_DIR: join(relocated, "agent"), PI_OFFLINE: "1" } });
		// then
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("two-production-client-workers-ready");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 45_000);
