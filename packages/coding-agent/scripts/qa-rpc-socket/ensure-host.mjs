#!/usr/bin/env node
/**
 * Live QA for `ensureHost` against a sandbox agent directory, on the CURRENT compatibility contract:
 * a host is usable when it speaks protocol 1 and advertises every required capability, and a host
 * that is NOT usable is refused - never replaced, never signalled (I1/I2). The version string is
 * informational and is deliberately made to differ in the reuse case, because comparing it is
 * exactly the behaviour this driver used to assert and the engine no longer has.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../src/config.ts";
import { processMatchesPidFile, waitForStartTime } from "../../src/modes/app-server/daemon/process.ts";
import { readHostRegistration, writeHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";
import { HostEnsureRefusedError, REQUIRED_HOST_CAPABILITIES } from "../../src/modes/rpc/host-decision.ts";
import { createHostDaemonPaths, ensureHost } from "../../src/modes/rpc/host-ensure.ts";

const lines = [];
const root = await mkdtemp(join(tmpdir(), "senpi-ensure-host-qa-"));
const agentDir = join(root, "agent");
const socket = join(root, "rpc.sock");
const paths = createHostDaemonPaths({ socket, agentDir });
let managed;
const fakes = [];
try {
	const started = await ensureHost({ socket, agentDir });
	managed = await registeredRecord();
	if (started.reused || started.pid !== managed.pid) {
		throw new Error(`unexpected first ensure: ${JSON.stringify(started)}`);
	}
	started.release();
	lines.push(`assert real-cli-start pid=${started.pid} reused=false version=${VERSION}`);

	const again = await ensureHost({ socket, agentDir });
	if (!again.reused || again.pid !== started.pid) throw new Error(`unexpected second ensure: ${JSON.stringify(again)}`);
	again.release();
	lines.push(`assert reuse-same-host pid=${again.pid} reused=true`);

	await stop(managed);
	await rm(socket, { force: true });

	// I2: a DIFFERENT serverVersion over the same protocol and capabilities is attachable. The old
	// contract replaced such a host, which on a machine-wide daemon ends another client's sessions.
	const compatible = await startFake("compatible", "0.0.0-qa", REQUIRED_HOST_CAPABILITIES);
	const reused = await ensureHost({ socket, agentDir });
	if (!reused.reused || reused.pid !== compatible.pid) {
		throw new Error(`a host with a different version was not reused: ${JSON.stringify(reused)}`);
	}
	if (!(await alive(compatible))) throw new Error(`compatible fake ${compatible.pid} did not survive the ensure`);
	reused.release();
	lines.push(`assert version-mismatch-reused pid=${reused.pid} serverVersion=0.0.0-qa`);

	await rm(paths.pointerFile, { force: true });
	await rm(socket, { force: true });
	compatible.child.kill("SIGKILL");

	// A host missing a required capability owns the socket, so no second host may be started on it -
	// and it is somebody else's process, so it is refused rather than signalled.
	const narrow = await startFake(
		"narrow",
		VERSION,
		REQUIRED_HOST_CAPABILITIES.filter((capability) => capability !== "session_context"),
	);
	const refusal = await ensureHost({ socket, agentDir }).catch((error) => error);
	if (!(refusal instanceof HostEnsureRefusedError) || refusal.reason !== "capability") {
		throw new Error(`expected a capability refusal, got: ${refusal?.message ?? JSON.stringify(refusal)}`);
	}
	if (!(await alive(narrow))) throw new Error(`refused host ${narrow.pid} was signalled`);
	lines.push(`assert missing-capability-refused pid=${narrow.pid} reason=${refusal.reason} hostAlive=true`);
	lines.push("PASS ensure-host start, reuse across versions, refusal without replacement");
} catch (error) {
	lines.push(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exitCode = 1;
} finally {
	if (managed) await stop(managed).catch(() => undefined);
	for (const fake of fakes) {
		try {
			fake.child.kill("SIGKILL");
		} catch {}
	}
	await rm(root, { recursive: true, force: true });
	lines.push(`cleanup=managed-host,fakes(${fakes.length}),socket,scratch-removed`);
}
process.stdout.write(`${lines.join("\n")}\n`);

/** The pid the daemon directory currently registers, read the way a client reads it. */
async function registeredRecord() {
	return (await readHostRegistration(paths)).record;
}

/**
 * A stand-in host on the public socket, registered under THIS process's writer stamp so the refusal
 * case proves refusal beats teardown even when the registration would permit a stop.
 */
async function startFake(label, serverVersion, capabilities) {
	const script = `
		import { rm } from "node:fs/promises";
		import { createServer } from "node:net";
		const socket = ${JSON.stringify(socket)};
		const answer = ${JSON.stringify({ protocolVersion: 1, serverVersion, capabilities: [...capabilities], mode: "multi" })};
		await rm(socket, { force: true });
		createServer((peer) => {
			let buffer = "";
			peer.on("data", (chunk) => {
				buffer += chunk;
				const newline = buffer.indexOf("\\n");
				if (newline < 0) return;
				const query = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				peer.write(\`\${JSON.stringify({ id: query.id, type: "response", command: "get_protocol_info", success: true, data: answer })}\n\`);
			});
		}).listen(socket);
		setInterval(() => {}, 1000);
	`;
	const file = join(root, `fake-${label}.mjs`);
	await writeFile(file, script);
	const child = spawn(process.execPath, [file], { detached: true, stdio: "ignore" });
	if (child.pid === undefined) throw new Error(`${label} fake did not spawn`);
	const processStartTime = await waitForStartTime(child.pid, 2_000);
	const fake = { pid: child.pid, processStartTime, child };
	fakes.push(fake);
	await mkdir(paths.dir, { recursive: true });
	await writeHostRegistration(paths, {
		record: { pid: child.pid, processStartTime },
		socket,
		instanceId: `qa-${label}-fake`,
		generation: 0,
		launchProfileId: "qa",
	});
	await waitForSocket(socket);
	return fake;
}

function alive(fake) {
	return processMatchesPidFile({ pid: fake.pid, processStartTime: fake.processStartTime });
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
			peer.once("connect", () => {
				peer.destroy();
				resolve(true);
			});
			peer.once("error", () => resolve(false));
		});
		if (connected) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("fake socket did not become ready");
}
