// #1473: real PTY keystrokes exercise InteractiveMode's recoverable resume path.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pty from "node-pty";
import {
	childRuntime,
	cliEntry,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	stripAnsi,
	tsxEntry,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { observeFrames } from "../lib/tui-frames.mjs";

installCleanupHooks();
const guard = guardRealAuth();
const box = makeSandbox("p1473-tui");
const evidence = evidenceDir("pr1473-resume-tui");
const server = await startFakeModelServer({
	turns: [{ text: "PR1473_TUI_SOURCE_READY" }, { text: "PR1473_TUI_SOURCE_SURVIVED" }],
});
writeMockModelsJson(box.agentDir, server, "openai-completions", { contextWindow: 100_000 });
writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({
	compaction: { enabled: false },
	retry: { enabled: false, modelFallback: false },
}));
const target = join(box.dir, "rejected.jsonl");
const timestamp = new Date(0).toISOString();
writeFileSync(target, [
	{ type: "session", version: 3, id: "rejected", cwd: box.cwd, timestamp },
	{ type: "message", id: "user", parentId: null, timestamp,
		message: { role: "user", content: "restored context ".repeat(40_000), timestamp: 0 } },
].map(entry => JSON.stringify(entry)).join("\n"));
const before = readFileSync(target);
const shutdown = join(box.dir, "shutdown");
const extension = join(box.dir, "resume.mjs");
writeFileSync(extension, `
import { appendFileSync } from "node:fs";
export default function(pi) {
 pi.on("session_start", () => pi.setSessionName("PR1473 QA"));
 pi.on("session_shutdown", event => appendFileSync(${JSON.stringify(shutdown)}, event.reason + "\\n"));
 pi.registerCommand("qa-resume", {
  description: "Exercise the real interactive resume boundary",
  handler: async (_args, ctx) => {
   const result = await ctx.switchSession(${JSON.stringify(target)});
   if (!result.cancelled) throw new Error("Oversized resume unexpectedly accepted");
   ctx.ui.notify("PR1473_TUI_RESUME_REFUSED", "info");
  },
 });
}`);
const runtime = childRuntime();
const root = repoRoot();
const flags = [
	"--provider", "mock", "--model", "mock-model",
	"--no-context-files", "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes",
	"--extension", extension, "--approve", "prepare source",
];
const args = runtime.kind === "binary" ? flags : runtime.kind === "bun"
	? [cliEntry(root), ...flags]
	: [tsxEntry(root), "--tsconfig", join(root, "tsconfig.json"), cliEntry(root), ...flags];
const env = hermeticEnv(box.env);
for (const name of Object.keys(env)) {
	if (name.startsWith("SENPI_RPC_")) delete env[name];
}
const term = pty.spawn(runtime.command, args, {
	name: "xterm-color", cols: 120, rows: 34, cwd: box.cwd, env,
});
const frames = observeFrames();
let capture = "";
let alive = true;
const exited = Promise.withResolvers();
term.onData(data => {
	capture += data;
	frames.push(data);
});
term.onExit(event => {
	alive = false;
	frames.fail(new Error(`TUI exited: ${event.exitCode}`));
	exited.resolve(event);
});
async function submit(text, marker) {
	const rendered = frames.waitFor(frame => frame.includes(marker), marker, 60_000);
	term.write(`${text}\r`);
	const frame = await rendered;
	writeFileSync(join(evidence, `${marker}.txt`), frame);
}
try {
	// The CLI sends its positional startup prompt only after InteractiveMode enables submission.
	await frames.waitFor(frame => frame.includes("PR1473_TUI_SOURCE_READY"), "source reply", 60_000);
	await submit("/qa-resume", "PR1473_TUI_RESUME_REFUSED");
	assert.equal(alive, true);
	assert.deepEqual(readFileSync(target), before);
	assert.equal(existsSync(shutdown), false);
	await submit("continue source after refused resume", "PR1473_TUI_SOURCE_SURVIVED");
	assert.equal(server.requests.length, 2);
	assert.equal(alive, true);
	guard.assertUnchanged();
	writeFileSync(join(evidence, "result.json"), JSON.stringify({
		pass: true,
		child_runtime: runtime.label,
		rejectedTargetUnchanged: true,
		shutdownBeforeRetry: false,
		followupRendered: true,
		localProviderRequests: server.requests.length,
		realAuthUnchanged: true,
	}, null, 2));
	console.log(`PASS actual TUI: resume refusal rendered, no shutdown, follow-up rendered (${runtime.label})`);
	console.log(`evidence: ${evidence}`);
} finally {
	writeFileSync(join(evidence, "terminal.txt"), stripAnsi(capture));
	if (alive) term.kill();
	let timer;
	try {
		await Promise.race([
			exited.promise,
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("TUI teardown deadline")), 10_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
		await server.stop();
		box.cleanup();
		guard.assertUnchanged();
	}
}
