/**
 * Warm-engine `open_session` bench (senpi#6256). Starts the REAL `--listen` host from source in a sandbox agent dir
 * whose only model is a local mock (no credentials, no model call can leave the machine), warms it with one open,
 * then opens N new sessions one after another on one connection and reports the client-side round trip of each open
 * and the p50 of every host `SENPI_OPEN_TIMING` phase.
 *
 *   bun scripts/bench-open-session.ts [n=12] [--json <file>] [-- <extra host args, e.g. --extension <path>>]
 *
 * Run it with stdio on pipes (not a terminal): under a PTY Bun can deliver async fs completions a timer tick late,
 * which measures the terminal, not the engine.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connectJsonlSocket } from "./qa-rpc-socket/lib/jsonl-socket.mjs";
import { startMockModel } from "./qa-rpc-socket/lib/mock-model.mjs";
import { MOCK_MODEL, MOCK_PROVIDER, sandboxHostEnv, writeSandboxAgentDir } from "./qa-rpc-socket/lib/qa-host.mjs";

const separator = process.argv.indexOf("--");
const args = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const hostArgs = separator === -1 ? [] : process.argv.slice(separator + 1);
const count = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 12);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const packageDir = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync("/tmp/senpi-ob-");
const agentDir = join(scratch, "agent");
const cwd = join(scratch, "cwd");
mkdirSync(cwd, { recursive: true });
const mock = await startMockModel(() => ({ text: "ok" }));
writeSandboxAgentDir(agentDir, { baseUrl: mock.baseUrl, workdir: cwd });
const socketPath = join(scratch, "h.sock");
const env: Record<string, string> = {};
for (const [key, value] of Object.entries({ ...process.env, ...sandboxHostEnv(agentDir) }))
	if (typeof value === "string") env[key] = value;
env.SENPI_OPEN_TIMING = "1";
env.HOME = scratch;
const profileDir = process.env.BENCH_HOST_CPU_PROF_DIR;
const host = spawn(
	"bun",
	[
		...(profileDir ? ["--cpu-prof", "--cpu-prof-dir", profileDir] : []),
		join(packageDir, "src", "cli.ts"), "--mode", "rpc", "--multi-session", "--listen", `unix://${socketPath}`,
		...hostArgs,
	],
	{ cwd, env, stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
const listening = new Promise<void>((ready, fail) => {
	host.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
		if (stderr.includes("senpi rpc listening on")) ready();
	});
	host.once("exit", (code) => fail(new Error(`host exited ${code}: ${stderr}`)));
});
const phases: Record<string, number[]> = {};
const opens: { roundTripMs: number }[] = [];
try {
	await listening;
	const client = await connectJsonlSocket(socketPath, 120_000);
	const openOnce = async () => {
		const response: { success: boolean; error?: string; elapsedMs: number; data?: { sessionId: string } } =
			await client.request({ type: "open_session", cwd, provider: MOCK_PROVIDER, modelId: MOCK_MODEL });
		if (!response.success || response.data === undefined) throw new Error(`open_session failed: ${response.error}`);
		await client.request({ type: "close_session", sessionId: response.data.sessionId });
		return { roundTripMs: response.elapsedMs };
	};
	await openOnce();
	const warmFrom = stderr.length;
	for (let index = 0; index < count; index++) opens.push(await openOnce());
	for (const line of stderr.slice(warmFrom).split("\n")) {
		const match = /^senpi open-timing \d+ (\S+?)(?::\S+)? (\S+) \+(\d+)ms$/.exec(line);
		if (match) (phases[`${match[1]}.${match[2]}`] ??= []).push(Number(match[3]));
	}
	client.dispose();
} finally {
	const exited = new Promise((done) => host.once("exit", done));
	host.kill("SIGTERM");
	await exited;
	mock.close?.();
	rmSync(scratch, { recursive: true, force: true });
}
const p50 = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
};
const report = {
	n: opens.length,
	roundTripP50Ms: p50(opens.map((open) => open.roundTripMs)),
	roundTripMs: opens.map((open) => Math.round(open.roundTripMs)),
	phaseP50Ms: Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, p50(values)])),
};
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(0);
