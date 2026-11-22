import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { readHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { STOP_WAIT_BUDGET_MS } from "../../../src/modes/rpc/host-ensure-stop.ts";
import {
	type GenerationScratch,
	generationEnv,
	generationScratch,
	JsonlPeer,
	openedSessionId,
} from "../../helpers/rpc-generation-support.ts";
import { captureStderr, caseBudget, waitForFixtureExit, waitForFixtureFile } from "../../helpers/fixture-ready.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { RpcOwnerProcesses } from "../../helpers/rpc-owner-processes.ts";

const fixture = join(import.meta.dirname, "../../fixtures/rpc-owner-caller.ts");
const rpcClientModule = join(import.meta.dirname, "../../../src/modes/rpc/rpc-client.ts");
const roots: GenerationScratch[] = [];
const processes = new RpcOwnerProcesses();
const peers: JsonlPeer[] = [];
const CASE_TIMEOUT_MS = 60_000;
const ownerOutput = new WeakMap<ChildProcess, () => string>();
const budget = caseBudget();

/**
 * The shape of an omo task tree inside its `p` shard: a session the host runs opens a nested child
 * on the SAME shard, so the host's own process is one of the shard's clients. The extension holds
 * a real `RpcClient` on the public socket, exactly as the task runner does, and stays connected.
 */
async function selfClientExtension(qa: GenerationScratch): Promise<{ path: string; ready: string }> {
	const path = join(qa.root, "self-client.ts");
	const ready = join(qa.root, "self-client-ready");
	await writeFile(
		path,
		`import { writeFileSync } from "node:fs";
import { RpcClient } from ${JSON.stringify(rpcClientModule)};
export default function (pi) {
	pi.on("session_start", async () => {
		// Phase stamps on the host's own stderr: a self-client that stalls or throws here would
		// otherwise leave only a missing file, with no way to tell slow from broken.
		const startedAt = Date.now();
		const stamp = (phase) => process.stderr.write(\`self-client \${phase} +\${Date.now() - startedAt}ms\n\`);
		try {
			stamp("session_start");
			const client = new RpcClient({ socketPath: ${JSON.stringify(qa.socket)} });
			await client.start();
			stamp("connected");
			await client.listSessions();
			stamp("listed");
			globalThis.__selfClient = client;
			writeFileSync(${JSON.stringify(ready)}, "1");
			stamp("ready");
		} catch (error) {
			process.stderr.write(\`self-client failed after \${Date.now() - startedAt}ms: \${String(error)}\n\`);
			throw error;
		}
	});
}
`,
	);
	return { path, ready };
}

async function caller(qa: GenerationScratch, ownership: "caller" | "none", extension: string, idleExitMs: number) {
	const child = spawn(process.execPath, [fixture, qa.socket, qa.agentDir, ownership, extension, String(idleExitMs)], {
		env: { ...hostSpawnEnv(), ...generationEnv(qa), SENPI_CODING_AGENT_DIR: qa.agentDir },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	ownerOutput.set(child, captureStderr(child));
	processes.owner(child);
	const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("caller readiness timeout")), 30_000);
		child.on("message", (message, handle) => {
			if (typeof message !== "object" || message === null || !("type" in message)) return;
			if (message.type === "supervisor" && "pid" in message && typeof message.pid === "number") {
				if (!(handle instanceof Socket)) return reject(new Error("missing transferred exit pipe"));
				processes.supervisor(message.pid, handle);
				return;
			}
			clearTimeout(timer);
			resolve({ ...message });
		});
	});
	expect(ready, JSON.stringify(ready)).toMatchObject({ type: "ready" });
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	const registration = await readHostRegistration(paths);
	if (!registration) throw new Error("no supervisor registration");
	processes.remember(registration.record.pid);
	const record = JSON.parse(await readFile(generationPaths(paths, registration.instanceId).childPidFile, "utf8"));
	processes.remember(record.pid);
	await processes.ready();
	return child;
}

/** The owner's stderr plus the supervisor's own log: between them they say why a boot failed. */
function fixtureOutput(qa: GenerationScratch, owner: ChildProcess): () => string {
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	return () => {
		let supervisor: string;
		try {
			supervisor = readFileSync(paths.stderrLog, "utf8");
		} catch {
			supervisor = "<no supervisor stderr log>";
		}
		return `[owner]\n${ownerOutput.get(owner)?.() ?? ""}\n[supervisor]\n${supervisor}`;
	};
}

async function seedSelfClient(qa: GenerationScratch, ready: string, owner: ChildProcess): Promise<void> {
	const outside = await JsonlPeer.connect(qa.socket);
	peers.push(outside);
	// Subscribed before the open that triggers the extension, so the write can never be missed.
	const written = waitForFixtureFile(ready, {
		timeoutMs: budget(CASE_TIMEOUT_MS),
		output: fixtureOutput(qa, owner),
		gone: once(owner, "exit"),
	});
	openedSessionId(
		await outside.request({ id: "open", type: "open_session", cwd: qa.cwd, retain_on_disconnect: true }),
	);
	await written;
	outside.destroy();
}

async function exitOwner(qa: GenerationScratch, owner: ChildProcess): Promise<void> {
	const exited = waitForFixtureExit(
		owner,
		{ timeoutMs: budget(CASE_TIMEOUT_MS), output: fixtureOutput(qa, owner) },
		"owner",
	);
	owner.send("exit");
	await exited;
}

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	await processes.cleanup();
	for (const qa of roots.splice(0)) await rm(qa.root, { recursive: true, force: true });
}, STOP_WAIT_BUDGET_MS + 30_000);

// #3272: a shard whose only remaining client is its own session must not hold itself alive.
describe.skipIf(process.platform === "win32")("RPC host self-client (#3272)", () => {
	it(
		"exits after its owner is gone when only its own session is still connected",
		async () => {
			const qa = generationScratch("self-owned");
			roots.push(qa);
			writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
			const extension = await selfClientExtension(qa);
			const owner = await caller(qa, "caller", extension.path, 600_000);
			await seedSelfClient(qa, extension.ready, owner);
			await exitOwner(qa, owner);
			await processes.allGone(budget(CASE_TIMEOUT_MS));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"idles out with no owner when only its own session is still connected",
		async () => {
			const qa = generationScratch("self-idle");
			roots.push(qa);
			writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
			const extension = await selfClientExtension(qa);
			const owner = await caller(qa, "none", extension.path, 2_000);
			await seedSelfClient(qa, extension.ready, owner);
			await exitOwner(qa, owner);
			await processes.allGone(budget(CASE_TIMEOUT_MS));
		},
		CASE_TIMEOUT_MS,
	);
});
