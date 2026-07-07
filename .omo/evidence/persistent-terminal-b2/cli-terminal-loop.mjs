/**
 * PR-B2 QA — full CLI-process agent-loop drive of the PTY terminal tools.
 *
 * Unlike native-tool-drive.mjs (which calls the tool factories in-process) and
 * the harness vitest (in-process AgentSession), this spawns the REAL senpi CLI
 * binary from source with EXTENSIONS ENABLED, so the builtin `terminal`
 * extension registers and OVERRIDES core `bash` with the PTY-backed bash + the
 * four companions inside the actual CLI process. A scripted fake model server
 * (zero tokens) drives a multi-turn loop:
 *   turn 1: bash { run_in_background:true, command:"sleep 0.4; echo READY_CLI_MARK" }
 *   turn 2: bash_output { bash_id, wait_for:"READY_CLI_MARK" }
 *   turn 3: final assistant text carrying the marker
 * A pass proves the PTY terminal suite works end-to-end through the full CLI
 * agent loop (registration + tool dispatch + background session + wait_for),
 * with the real auth.json sha256 unchanged.
 *
 * Run from repo root:
 *   node .omo/evidence/persistent-terminal-b2/cli-terminal-loop.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "../../../.agents/skills/senpi-qa/scripts/lib/common.mjs";
import { startFakeModelServer } from "../../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../../../.agents/skills/senpi-qa/scripts/lib/mock-loop-support.mjs";

const MARKER = "READY_CLI_MARK";
const FINAL = "CLI-TERMINAL-LOOP-OK-5f21";

async function main() {
	installCleanupHooks();
	const checks = createChecks("cli-terminal-loop.mjs — full CLI PTY terminal agent loop");
	const guard = guardRealAuth();
	const box = makeSandbox("cli-terminal-loop");
	// Scripted turns: background bash -> bash_output(wait_for) -> final text.
	const server = await startFakeModelServer({
		turns: [
			{ toolCalls: [{ name: "bash", args: { command: "sleep 0.4; echo READY_CLI_MARK", run_in_background: true } }] },
			{ toolCalls: [{ name: "bash_output", args: { bash_id: "bash_1", wait_for: MARKER, timeout: 10 } }] },
			{ text: `Done: ${FINAL}` },
		],
	});
	writeMockModelsJson(box.agentDir, server, "openai-completions");

	// EXTENSIONS ENABLED (no --no-extensions): terminal builtin registers PTY bash + companions.
	const args = [
		"--provider",
		"mock",
		"--model",
		"mock-model",
		"--no-context-files",
		"--approve",
		"--print",
		"Start a background shell that prints a marker, then read its output.",
	];
	const result = await runCli(args, { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 120000 });
	const out = result.stdout + result.stderr;

	checks.ok("CLI completed the multi-step loop", !result.timedOut, `code=${result.code} timedOut=${result.timedOut}`);
	checks.ok("three model turns served (loop iterated)", server.requests.length >= 3, `requests=${server.requests.length}`);
	// The 2nd request payload must carry the tool_result for the background bash (its bash_id line),
	// and the 3rd request must carry the wait_for-resolved READY_CLI_MARK output — proving the PTY
	// session actually ran inside the CLI and its output flowed back into the loop.
	const req2 = JSON.stringify(server.requests[1]?.messages ?? "");
	const req3 = JSON.stringify(server.requests[2]?.messages ?? "");
	checks.ok("turn-2 payload shows a background bash_id (PTY bash ran in CLI)", /bash_\d+/.test(req2), `req2 has bash_id=${/bash_\d+/.test(req2)}`);
	checks.ok("turn-3 payload shows wait_for-resolved marker output", req3.includes(MARKER), `req3 hasMarker=${req3.includes(MARKER)}`);
	checks.ok("final assistant text returned via CLI", out.includes(FINAL), `hasFinal=${out.includes(FINAL)}`);

	const g = guard.diff ? guard.diff() : null;
	checks.ok("real auth.json sha256 unchanged", guard.assertUnchanged ? (guard.assertUnchanged(), true) : true, "");

	if (!checks.finish || result.timedOut || server.requests.length < 3) {
		process.stderr.write(`\n--- stderr tail ---\n${result.stderr.slice(-2000)}\n`);
	}
	// Persist a transcript snapshot for evidence.
	const dir = evidenceDir("persistent-terminal-b2-cli");
	writeFileSync(join(dir, "cli-terminal-loop-requests.json"), JSON.stringify(server.requests, null, 2));
	writeFileSync(join(dir, "cli-terminal-loop-stdout.txt"), result.stdout);

	await server.stop();
	box.cleanup();
	process.exit(checks.finish() ? 0 : 1);
}

main().catch((e) => {
	process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
	process.exit(1);
});
