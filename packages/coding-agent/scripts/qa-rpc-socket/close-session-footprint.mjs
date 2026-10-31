#!/usr/bin/env bun
/**
 * Footprint curve for in-process `close_session` (senpi#2292), on BUN.
 *
 * Runs ONE in-process host core (the `RpcSessionRegistry` a `--listen` host
 * selects) and, for each of N sessions: open it, have its extension allocate a
 * touched buffer behind a loopback `Bun.serve` listener (the #2292 fixture),
 * then close it. Every `--every` sessions it forces two full collections and
 * samples the host: footprint (`phys_footprint` on macOS), RSS, live JS heap
 * and TCP LISTEN sockets the process still owns.
 *
 * `--extension` picks what the fixture does on `session_shutdown`:
 *   leaky     - nothing (the #2292 report)
 *   teardown  - stops its server (what docs/extensions.md asks for)
 *   none      - no fixture at all (senpi's own per-session cost)
 *
 * Usage:
 *   bun scripts/qa-rpc-socket/close-session-footprint.mjs [--extension leaky] [--sessions 30] [--every 5] [--mb 16] [--out <file>] [--vmmap <file>]
 *
 * `--vmmap <file>` (macOS) writes `vmmap -summary` of the host after the last sample.
 *
 * The last stdout line is the JSON report: { config, samples: [{ sessions, footprintMb, rssMb, heapMb, listeners }] }.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { parseArgs } from "../../src/cli/args.ts";
import { readOwnFootprint } from "../../src/core/process-footprint.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const extension = flag("--extension") ?? "leaky";
const sessions = Number(flag("--sessions") ?? 30);
const every = Number(flag("--every") ?? 5);
const allocMb = Number(flag("--mb") ?? 16);
const outPath = flag("--out");
const vmmapPath = flag("--vmmap");
if (!["leaky", "teardown", "none"].includes(extension)) throw new Error(`unknown --extension ${extension}`);

const scratch = mkdtempSync(join(tmpdir(), "close-footprint-"));
const agentDir = join(scratch, "agent");
const cwd = join(scratch, "cwd");
mkdirSync(agentDir);
mkdirSync(cwd);
process.env.SENPI_CODING_AGENT_DIR = agentDir;
process.env.OMO_CODING_AGENT_DIR = agentDir;
for (const key of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"]) delete process.env[key];

// The #2292 fixture as a FILE extension (`-e`), like the issue's reproduction: a touched buffer kept
// reachable by a loopback listener, stopped on session_shutdown only in `teardown` mode.
const fixturePath = join(scratch, "memory-fixture.mjs");
writeFileSync(
	fixturePath,
	`export default function (pi) {
	const servers = [];
	pi.rpc.handle("memory.allocate", () => {
		const bytes = new Uint8Array(${allocMb} * 1024 * 1024);
		bytes.fill(17);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(String(bytes.byteLength)) });
		servers.push(server);
		return { port: server.port };
	});
	${extension === "teardown" ? 'pi.on("session_shutdown", () => servers.splice(0).forEach((s) => s.stop(true)));' : ""}
}
`,
);

const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
const model = faux.getModel();
const parsed = parseArgs([
	"--mode",
	"rpc",
	"--multi-session",
	"--no-extensions",
	...(extension === "none" ? [] : ["-e", fixturePath]),
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-themes",
]);

const fauxProvider = (pi) =>
	pi.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
		})),
	});

const responses = new Map();
const writer = new SessionEventWriter((chunk) => {
	for (const line of chunk.split("\n")) {
		if (!line) continue;
		const record = JSON.parse(line);
		if (record.id) responses.set(record.id, record);
	}
});
const { router } = createHostCore(
	{
		agentDir,
		cwd,
		permissionPreset: "full-access",
		createRuntime: createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{ extensionFactories: [fauxProvider] },
		),
		creationModel: { provider: model.provider, modelId: model.id },
	},
	writer,
	[],
);

let serial = 0;
let errors = 0;
async function send(command) {
	const id = `fp-${++serial}`;
	const immediate = await router.handle({ ...command, id });
	await writer.flush();
	const record = immediate ?? responses.get(id);
	responses.delete(id);
	if (record?.success !== true) {
		errors++;
		process.stderr.write(`command failed: ${JSON.stringify(command)} -> ${JSON.stringify(record)}\n`);
	}
	return record;
}

function listeners() {
	try {
		const out = execFileSync("lsof", ["-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
		return out.split("\n").filter((line) => line.startsWith("n")).length;
	} catch {
		return 0; // lsof exits 1 when nothing matches
	}
}

const mb = (bytes) => Math.round(bytes / 1_000_000);
async function sample(done) {
	for (let pass = 0; pass < 2; pass++) {
		Bun.gc(true);
		await new Promise((settle) => setTimeout(settle, 500));
	}
	return {
		sessions: done,
		footprintMb: mb(readOwnFootprint().bytes),
		rssMb: mb(process.memoryUsage.rss()),
		heapMb: mb(process.memoryUsage().heapUsed),
		listeners: listeners(),
	};
}

// One warm cycle first: the runtime's one-time costs are not what this cell measures.
const warm = await send({ type: "open_session", cwd });
await send({ type: "close_session", sessionId: warm.data.sessionId });

const samples = [await sample(0)];
for (let done = 1; done <= sessions; done++) {
	const opened = await send({ type: "open_session", cwd });
	const sessionId = opened.data.sessionId;
	if (extension !== "none") await send({ type: "extension_request", sessionId, name: "memory.allocate" });
	await send({ type: "close_session", sessionId });
	if (done % every === 0 || done === sessions) samples.push(await sample(done));
}

if (vmmapPath) writeFileSync(vmmapPath, execFileSync("vmmap", ["-summary", String(process.pid)], { encoding: "utf8" }));

const report = {
	config: { extension, sessions, allocMb, runtime: "in-process", bun: Bun.version, platform: `${process.platform}-${process.arch}` },
	samples,
	sessionsLeft: router.sessionCount,
	errors,
};
await router.dispose();
rmSync(scratch, { recursive: true, force: true });
const line = JSON.stringify(report);
if (outPath) writeFileSync(outPath, `${line}\n`);
process.stdout.write(`${line}\n`);
process.exit(0);

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}
