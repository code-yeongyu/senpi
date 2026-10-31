// senpi#3519 host heap measurement (benchmark, not a test gate). It starts a real RPC host from this checkout's
// source, opens `--sessions` compacted transcripts of `--mb` MB each (generated, or `--file` real ones), and
// prints the host's live heap read from a memory_report heap snapshot, which is taken after a full collection.
//
//   bun packages/coding-agent/test/benchmarks/3519-host-heap.ts --sessions 4 --mb 150
//   bun packages/coding-agent/test/benchmarks/3519-host-heap.ts --file a.jsonl --file b.jsonl
//
// Run it from two checkouts (main and the PR) to compare; numbers depend on the transcripts, not the machine.
import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeCompactedTranscript } from "./3519-compacted-transcript.ts";

const argv = process.argv.slice(2);
const values = (name: string) => argv.flatMap((arg, index) => (arg === `--${name}` ? [argv[index + 1] ?? ""] : []));
const sessions = Number(values("sessions")[0] ?? "4");
const megabytes = Number(values("mb")[0] ?? "150");
const cli = resolve(import.meta.dirname, "../../src/cli.ts");

const root = realpathSync(mkdtempSync(join(tmpdir(), "s3519-bench-")));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
const files = values("file").map((file) => {
	const copy = join(sessionDir, basename(file));
	copyFileSync(file, copy);
	return copy;
});
const generate = files.length === 0;
for (let index = 0; generate && index < sessions; index++) {
	const dir = join(sessionDir, `s${index}`);
	mkdirSync(dir);
	files.push(writeCompactedTranscript(dir, megabytes));
}

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
	if (value !== undefined && !/^(OMO_|SENPI_|PI_)/.test(key)) env[key] = value;
Object.assign(env, {
	HOME: root,
	SENPI_CODING_AGENT_DIR: agentDir,
	SENPI_MEMORY_REPORT: "1",
	SENPI_MEMORY_REPORT_SNAPSHOT: "1",
	CI: "1",
});
const socket = join(root, "host.sock");
const host = spawn(process.execPath, [cli, "--mode", "rpc", "--listen", `unix://${socket}`], {
	env,
	cwd: root,
	stdio: "ignore",
});
let hostExitCode: number | null | undefined;
const hostExited = new Promise((exited) =>
	host.once("exit", (code) => {
		hostExitCode = code;
		exited(code);
	}),
);
for (let attempt = 0; attempt < 600 && !existsSync(socket) && hostExitCode === undefined; attempt++) await sleep(100);
if (!existsSync(socket)) {
	host.kill("SIGTERM");
	rmSync(root, { recursive: true, force: true });
	throw new Error(
		hostExitCode === undefined
			? "the RPC host did not listen within 60 s"
			: `the RPC host exited with code ${hostExitCode} before listening`,
	);
}

const connection = createConnection(socket);
await new Promise((ready) => connection.once("connect", ready));
connection.setEncoding("utf8");
const pending = new Map<
	string,
	(answer: { success?: boolean; data?: Record<string, unknown>; error?: string }) => void
>();
let buffer = "";
connection.on("data", (chunk: string) => {
	buffer += chunk;
	for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		const record = JSON.parse(line);
		if (record.type === "response") pending.get(record.id)?.(record);
	}
});
let nextId = 0;
const request = (command: Record<string, unknown>) =>
	new Promise<{ success?: boolean; data?: Record<string, unknown>; error?: string }>((answer) => {
		const id = `q${nextId++}`;
		pending.set(id, answer);
		connection.write(`${JSON.stringify({ ...command, id })}\n`);
	});

const liveHeapMb = (snapshotPath: string): number => {
	const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
	const fields: string[] = snapshot.snapshot.meta.node_fields;
	const selfSize = fields.indexOf("self_size");
	let bytes = 0;
	for (let index = selfSize; index < snapshot.nodes.length; index += fields.length) bytes += snapshot.nodes[index];
	rmSync(snapshotPath, { force: true });
	return Math.round(bytes / 1048576);
};

const opened: string[] = [];
const started = Date.now();
for (const file of files) {
	const answer = await request({ type: "open_session", sessionPath: file, cwd: root });
	if (!answer.success) throw new Error(`open_session failed: ${answer.error}`);
	opened.push(String(answer.data?.sessionId));
}
const openMs = Date.now() - started;
const report = await request({ type: "memory_report", sessionId: opened[0] });
const snapshot = report.data?.heapSnapshot;
console.log(
	JSON.stringify({
		cli,
		transcripts: files.length,
		transcriptMb: Math.round(files.reduce((sum, file) => sum + statSync(file).size, 0) / 1048576),
		openMs,
		liveHeapMb: typeof snapshot === "string" ? liveHeapMb(snapshot) : null,
	}),
);
connection.end();
host.kill("SIGTERM");
await hostExited;
rmSync(root, { recursive: true, force: true });
