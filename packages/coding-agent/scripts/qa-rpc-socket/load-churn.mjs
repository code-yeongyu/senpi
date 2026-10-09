#!/usr/bin/env bun
/**
 * Session CHURN cell for the shared multi-session host, on BUN.
 *
 * Opens and closes N sessions on ONE in-process host core (`createHostCore`
 * without `workerConfiguration`, i.e. the `RpcSessionRegistry` a `--listen` host
 * selects) and reports what the process kept afterwards: resident set, live JS
 * heap after a forced full GC, thread count, and `bunExtensionImporterStats()`.
 *
 * It runs under BUN on purpose. The importer counter only moves when the BUN
 * extension importer registers a graph, and only `Bun.gc(true)` can force the
 * full collection that separates "retained" from "not yet swept" - under Node
 * both numbers are meaningless. `test/suite/rpc-inprocess-load.test.ts` spawns
 * this script for its churn section; it also runs standalone.
 *
 * Usage:
 *   bun scripts/qa-rpc-socket/load-churn.mjs [--cycles 2000] [--concurrency 50] [--out <file>]
 *
 * The last stdout line is the JSON report.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { parseArgs } from "../../src/cli/args.ts";
import { bunExtensionImporterStats } from "../../src/core/extensions/bun-extension-registry.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const cycles = Number(flag("--cycles") ?? 2000);
const concurrency = Number(flag("--concurrency") ?? 50);
const outPath = flag("--out");

const scratch = mkdtempSync(join(tmpdir(), "dh-churn-"));
const agentDir = join(scratch, "agent");
const cwd = join(scratch, "cwd");
mkdirSync(agentDir);
mkdirSync(cwd);
// Never resolve a churn session against the developer's live agent dir.
process.env.SENPI_CODING_AGENT_DIR = agentDir;
process.env.OMO_CODING_AGENT_DIR = agentDir;
for (const key of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"]) delete process.env[key];

const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
const model = faux.getModel();
const parsed = parseArgs([
	"--mode",
	"rpc",
	"--multi-session",
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-themes",
]);
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
			{
				extensionFactories: [
					(pi) =>
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
						}),
				],
			},
		),
		creationModel: { provider: model.provider, modelId: model.id },
	},
	writer,
	[],
);

let serial = 0;
let errors = 0;
async function send(command) {
	const id = `churn-${++serial}`;
	const immediate = await router.handle({ ...command, id });
	await writer.flush();
	const record = immediate ?? responses.get(id);
	responses.delete(id);
	if (record?.success !== true) errors++;
	return record;
}

const threads = () => execFileSync("ps", ["-M", String(process.pid)], { encoding: "utf8" }).trim().split("\n").length - 1;
const mb = (bytes) => Math.round(bytes / 1_000_000);

// One warm cycle first: the runtime's one-time costs are not what this cell measures.
const warm = await send({ type: "open_session", cwd });
await send({ type: "close_session", sessionId: warm.data.sessionId });
const before = { rss: process.memoryUsage.rss(), heap: process.memoryUsage().heapUsed, threads: threads() };
const importerBefore = bunExtensionImporterStats();

const startedAt = performance.now();
for (let done = 0; done < cycles; done += concurrency) {
	const batch = Math.min(concurrency, cycles - done);
	const opened = await Promise.all(Array.from({ length: batch }, () => send({ type: "open_session", cwd })));
	await Promise.all(opened.map((record) => send({ type: "close_session", sessionId: record.data.sessionId })));
}
const elapsedMs = performance.now() - startedAt;

// Two forced full collections with a settle between: the FinalizationRegistry that
// drops a collected extension graph runs on the second one.
for (let pass = 0; pass < 2; pass++) {
	globalThis.Bun?.gc(true);
	await new Promise((settle) => setTimeout(settle, 1_000));
}

const report = {
	cycles,
	concurrency,
	elapsedMs: Math.round(elapsedMs),
	rssBeforeMb: mb(before.rss),
	rssAfterMb: mb(process.memoryUsage.rss()),
	heapBeforeMb: mb(before.heap),
	heapAfterMb: mb(process.memoryUsage().heapUsed),
	threadsBefore: before.threads,
	threadsAfter: threads(),
	importerBefore,
	importerAfter: bunExtensionImporterStats(),
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
