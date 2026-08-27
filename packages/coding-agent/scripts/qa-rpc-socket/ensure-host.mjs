#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../src/config.ts";
import { processMatchesPidFile, waitForStartTime } from "../../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths, ensureHost } from "../../src/modes/rpc/host-ensure.ts";

const lines = [];
const root = await mkdtemp(join(tmpdir(), "senpi-ensure-host-qa-"));
const agentDir = join(root, "agent");
const socket = join(root, "rpc.sock");
let managed;
let fake;
try {
	const started = await ensureHost({ socket, agentDir });
	managed = await readManagedPid(agentDir);
	if (started.reused || started.pid !== managed.pid) throw new Error(`unexpected first ensure: ${JSON.stringify(started)}`);
	lines.push(`assert real-cli-start pid=${started.pid} reused=false version=${VERSION}`);

	await stop(managed);
	await rm(socket, { force: true });
	fake = await startWrongVersionFake(socket);
	const paths = createHostDaemonPaths(agentDir);
	await mkdir(paths.dir, { recursive: true });
	const fakeStart = await waitForStartTime(fake.pid, 2_000);
	await writeFile(paths.pidFile, `${JSON.stringify({ pid: fake.pid, processStartTime: fakeStart })}\n`, { mode: 0o600 });
	await writeFile(paths.settingsFile, `${JSON.stringify({ socket })}\n`, { mode: 0o600 });
	await waitForSocket(socket);

	const replaced = await ensureHost({ socket, agentDir });
	managed = await readManagedPid(agentDir);
	if (replaced.reused || replaced.pid === fake.pid || replaced.pid !== managed.pid) {
		throw new Error(`unexpected replacement: ${JSON.stringify(replaced)}`);
	}
	if (await processMatchesPidFile({ pid: fake.pid, processStartTime: fakeStart })) {
		throw new Error(`wrong-version fake ${fake.pid} survived replacement`);
	}
	lines.push(`assert version-mismatch-replaced oldPid=${fake.pid} newPid=${replaced.pid}`);
	lines.push("PASS ensure-host real CLI auto-start and replacement");
} finally {
	if (managed) await stop(managed).catch(() => undefined);
	if (fake?.pid) try { process.kill(fake.pid, "SIGKILL"); } catch {}
	await rm(root, { recursive: true, force: true });
	lines.push("cleanup=managed-host,fake-host,socket,scratch-removed");
}
process.stdout.write(`${lines.join("\n")}\n`);

async function readManagedPid(agentDir) {
	return JSON.parse(await readFile(createHostDaemonPaths(agentDir).pidFile, "utf8"));
}

async function startWrongVersionFake(socketPath) {
	const script = `
		import { rm } from "node:fs/promises";
		import { createServer } from "node:net";
		const socket = ${JSON.stringify(socketPath)};
		await rm(socket, { force: true });
		createServer((peer) => { let b = ""; peer.on("data", (c) => { b += c; const n = b.indexOf("\\n"); if (n < 0) return; const q = JSON.parse(b.slice(0,n)); peer.write(JSON.stringify({id:q.id,type:"response",command:"get_protocol_info",success:true,data:{protocolVersion:1,serverVersion:"0.0.0-qa",capabilities:["multi_session","extension_events"],mode:"multi"}})+"\\n"); }); }).listen(socket);
		setInterval(() => {}, 1000);
	`;
	const file = join(root, "wrong-version.mjs");
	await writeFile(file, script);
	const child = spawn(process.execPath, [file], { detached: true, stdio: "ignore" });
	if (child.pid === undefined) throw new Error("wrong-version fake did not spawn");
	child.unref();
	return { pid: child.pid };
}

async function stop(pidFile) {
	if (!(await processMatchesPidFile(pidFile))) return;
	process.kill(pidFile.pid, "SIGTERM");
	const deadline = Date.now() + 3_000;
	while (Date.now() <= deadline) {
		if (!(await processMatchesPidFile(pidFile))) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (await processMatchesPidFile(pidFile)) process.kill(pidFile.pid, "SIGKILL");
}

async function waitForSocket(socketPath) {
	const deadline = Date.now() + 2_000;
	while (Date.now() <= deadline) {
		const connected = await new Promise((resolve) => {
			const peer = createConnection(socketPath);
			peer.once("connect", () => { peer.destroy(); resolve(true); });
			peer.once("error", () => resolve(false));
		});
		if (connected) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("fake socket did not become ready");
}
