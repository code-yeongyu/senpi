// senpi#3110 busy-run footprint (benchmark, not a test gate). It starts a real RPC host from this checkout's
// source, reopens `--sessions` compacted transcripts of `--mb` MB each (generated, or `--file` real ones) the way
// a respawned task host resumes its children, then keeps every session in long runs (`--runs` runs of
// BENCH_TOOLS_PER_RUN tool calls each) and samples the host's memory footprint every second.
//
//   bun packages/coding-agent/test/benchmarks/3110-busy-run-footprint.ts --sessions 4 --mb 100 --runs 2
//
// Run it from two checkouts (main and the PR) to compare. It prints one JSON line: the open peak, the footprint
// while runs are active, and the footprint once every session settled.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readProcessFootprint } from "../../src/core/process-footprint.ts";
import { writeCompactedTranscript } from "./3519-compacted-transcript.ts";

const argv = process.argv.slice(2);
const values = (name: string) => argv.flatMap((arg, index) => (arg === `--${name}` ? [argv[index + 1] ?? ""] : []));
const sessions = Number(values("sessions")[0] ?? "4");
const megabytes = Number(values("mb")[0] ?? "100");
const runs = Number(values("runs")[0] ?? "2");
const cli = resolve(import.meta.dirname, "../../src/cli.ts");
const provider = resolve(import.meta.dirname, "3110-scripted-provider.ts");

const root = realpathSync(mkdtempSync(join(tmpdir(), "s3110-bench-")));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const cwd = join(root, "project");
for (const dir of [agentDir, sessionDir, cwd]) mkdirSync(dir, { recursive: true });
writeFileSync(join(cwd, "README.md"), "bench\n");
writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [cwd]: true })}\n`);
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
	TMPDIR: root,
	SENPI_CODING_AGENT_DIR: agentDir,
	SENPI_RPC_HOST_REAPER: "0",
	SENPI_TELEMETRY_DISABLED: "1",
});
const socket = join(root, "h.sock");
const host = spawn(
	process.execPath,
	[
		cli,
		"--mode",
		"rpc",
		"--multi-session",
		"--listen",
		`unix://${socket}`,
		"--session-runtime",
		"in-process",
		"-e",
		provider,
		"--provider",
		"bench3110",
		"--model",
		"m1",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--no-themes",
	],
	{ cwd, env, stdio: ["ignore", "ignore", "inherit"] },
);
const hostPid = host.pid ?? 0;
const footprintMb = () => Math.round((readProcessFootprint(hostPid)?.bytes ?? Number.NaN) / 1048576);

for (let attempt = 0; attempt < 600 && !existsSync(socket); attempt++) await sleep(100);
const connection = createConnection(socket);
await new Promise((ready) => connection.once("connect", ready));
type Reply = { readonly success?: boolean; readonly data?: Record<string, unknown>; readonly error?: string };
const waiting = new Map<string, (reply: Reply) => void>();
let buffered = "";
connection.on("data", (chunk) => {
	buffered += chunk.toString();
	for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
		const line = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		if (!line.includes('"response"')) continue;
		const reply = JSON.parse(line);
		waiting.get(reply.id)?.(reply);
		waiting.delete(reply.id);
	}
});
let sequence = 0;
const call = (command: Record<string, unknown>) =>
	new Promise<Reply>((settle) => {
		const id = `b${++sequence}`;
		waiting.set(id, settle);
		connection.write(`${JSON.stringify({ id, ...command })}\n`);
	});

let phase: "open" | "run" | "settled" = "open";
const samples: { phase: string; mb: number }[] = [];
const sampler = setInterval(() => samples.push({ phase, mb: footprintMb() }), 1000);
const started = footprintMb();
const opened = await Promise.all(files.map((sessionPath) => call({ type: "open_session", sessionPath, cwd })));
const ids = opened.map((reply) => reply.data?.sessionId).filter((id): id is string => typeof id === "string");
if (ids.length !== files.length)
	throw new Error(`open failed: ${JSON.stringify(opened.find((reply) => !reply.success))}`);
phase = "run";
await Promise.all(
	ids.map(async (sessionId) => {
		for (let index = 0; index < runs; index++) {
			await call({ type: "prompt", sessionId, message: `run ${index}` });
			for (;;) {
				const state = await call({ type: "get_state", sessionId });
				if (state.data?.isStreaming === false && state.data?.isCompacting === false) break;
				await sleep(200);
			}
		}
	}),
);
phase = "settled";
await sleep(10_000);
clearInterval(sampler);

const of = (name: string) =>
	samples.filter((sample) => sample.phase === name && Number.isFinite(sample.mb)).map((s) => s.mb);
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? Number.NaN;
console.log(
	JSON.stringify({
		sessions: ids.length,
		transcriptMb: generate ? megabytes : null,
		runs,
		startedMb: started,
		openPeakMb: Math.max(...of("open"), ...of("run").slice(0, 1)),
		runMedianMb: median(of("run")),
		runPeakMb: Math.max(...of("run")),
		settledMb: of("settled").at(-1),
		curve: samples.map((sample) => `${sample.phase[0]}${sample.mb}`).join(" "),
	}),
);
connection.destroy();
host.kill("SIGTERM");
await new Promise((exited) => host.once("exit", exited));
rmSync(root, { recursive: true, force: true });
