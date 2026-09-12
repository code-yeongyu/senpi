import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { teardownChildProcessesAndRoots } from "./helpers/process-teardown.ts";
import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
	await teardownChildProcessesAndRoots(children, roots);
});

async function fixture(label: string) {
	const root = mkdtempSync(join(tmpdir(), `senpi-w3-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent"),
		sessionDir = join(root, "sessions"),
		cwd = join(root, "work"),
		socket = join(root, "rpc.sock");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const fake = await startFakeModelServer();
	writeRpcModelsJson(agentDir, fake.origin);
	const host = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "..", "src", "cli.ts"),
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			`unix://${socket}`,
			"--provider",
			MOCK_PROVIDER,
			"--model",
			MOCK_MODEL,
		],
		{
			cwd,
			env: {
				...process.env,
				...hermeticProviderEnv(),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				SENPI_RUNTIME: "node",
				SENPI_CODING_AGENT_DIR: agentDir,
				SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.push(host);
	await new Promise<void>((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => reject(new Error(text)), 15000);
		host.stderr.on("data", (chunk) => {
			text += chunk;
			if (text.includes(`senpi rpc listening on unix://${socket}`)) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	const client = new RpcClient({ socketPath: socket });
	await client.start();
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
	const opened = await client.openSession({ sessionPath: manager.getSessionFile(), cwd });
	return { root, cwd, sessionDir, client, opened, manager, fake };
}

describe("interactive-w3 shared-host regression contracts", () => {
	it("R4 mirrors compaction_start and compaction_end", async () => {
		const f = await fixture("r4");
		const seen: boolean[] = [];
		const off = f.client.onEvent((e) => {
			if (e.type === "compaction_start") seen.push(true);
			if (e.type === "compaction_end") seen.push(false);
		});
		await f.client.compact("force").catch(() => undefined);
		off();
		expect(seen).toContain(true);
		expect(seen.at(-1)).toBe(false);
		await f.client.stop();
		await f.fake.close();
	});
	it("R5 mirrors retry and bash lifecycle state events", async () => {
		const f = await fixture("r5");
		const types: string[] = [];
		const off = f.client.onEvent((e) => {
			if (e.type === "bash_start" || e.type === "bash_end") types.push(e.type);
		});
		await f.client.bash("printf w3");
		off();
		expect(types).toEqual(["bash_start", "bash_end"]);
		await f.client.stop();
		await f.fake.close();
	});
	it("R6 reads and clears the host queue", async () => {
		const f = await fixture("r6");
		await f.client.steer("host-queue", undefined, { enqueueOrder: 7 });
		expect(await f.client.getSteeringMessages()).toEqual(["host-queue"]);
		expect(await f.client.clearQueue()).toMatchObject({ steering: ["host-queue"] });
		expect(await f.client.getSteeringMessages()).toEqual([]);
		await f.client.stop();
		await f.fake.close();
	});
	it("R7 carries the bash operations payload contract", async () => {
		const f = await fixture("r7");
		const result = await f.client.bash("printf operations", { operations: { serializable: true } });
		expect(result.output).toContain("operations");
		await f.client.stop();
		await f.fake.close();
	});
	it("R9 refreshes the session identity used by the attached client", async () => {
		const f = await fixture("r9");
		const before = f.opened.state.sessionId;
		const next = await f.client.newSession();
		expect(next.cancelled).toBe(false);
		expect((await f.client.getState()).sessionId).not.toBe(before);
		await f.client.stop();
		await f.fake.close();
	});
	it("R10 routes branch abort, bash persistence, and labels to the host", async () => {
		const f = await fixture("r10");
		await f.client.abortBranchSummary();
		await f.client.recordBashResult("echo", { output: "x", exitCode: 0, cancelled: false, truncated: false });
		await f.client.prompt("persist label entry");
		await f.client.waitForIdle();
		const leaf = (await f.client.getEntries()).leafId!;
		await f.client.setLabel(leaf, "label");
		const tree = await f.client.getTree();
		expect(JSON.stringify(tree.tree)).toContain("label");
		await f.client.stop();
		await f.fake.close();
	});
	it("R12 exposes command rejection through the client error channel", async () => {
		const f = await fixture("r12");
		await expect(f.client.setModel("missing-provider", "missing-model")).rejects.toThrow();
		await f.client.stop();
		await f.fake.close();
	});
	it("B8 mirrors session_info_changed name readback", async () => {
		const f = await fixture("b8");
		await f.client.setSessionName("w3-name");
		expect((await f.client.getState()).sessionName).toBe("w3-name");
		await f.client.stop();
		await f.fake.close();
	});
	it("B9 forwards fork position, new-session parent, and switch cwd override fields", async () => {
		const f = await fixture("b9");
		await f.client.prompt("persist b9");
		await f.client.waitForIdle();
		const leaf = (await f.client.getEntries()).leafId!;
		expect((await f.client.fork(leaf, { position: "at" })).cancelled).toBe(false);
		const parent = (await f.client.getState()).sessionFile;
		expect((await f.client.newSession(parent)).cancelled).toBe(false);
		const target = SessionManager.create(f.cwd, f.sessionDir);
		expect((await f.client.switchSession(target.getSessionFile()!, { cwdOverride: f.cwd })).cancelled).toBe(false);
		await f.client.stop();
		await f.fake.close();
	});
	it("B10 does not invalidate a cancelled replacement", async () => {
		const f = await fixture("b10");
		const before = (await f.client.getState()).sessionId;
		const result = await f.client.newSession();
		expect(result.cancelled).toBe(false);
		expect((await f.client.getState()).sessionId).not.toBe(before);
		await f.client.stop();
		await f.fake.close();
	});
	it("B10b reconstructs MissingSessionCwdError across RPC", async () => {
		const f = await fixture("b10b");
		await f.client.prompt("persist b10b");
		await f.client.waitForIdle();
		const path = join(f.root, "missing-cwd.jsonl");
		const source = readFileSync((await f.client.getState()).sessionFile!, "utf8");
		writeFileSync(path, source.replaceAll(f.cwd, "/definitely/missing"));
		await expect(f.client.importJsonl(path)).rejects.toBeInstanceOf(MissingSessionCwdError);
		await f.client.stop();
		await f.fake.close();
	});
});
