/**
 * Permanent continuity scenario matrix for the claude-sdk-oauth lane.
 *
 * Drives every scenario phase in ONE hermetic run against the REAL stack and
 * enforces the continuity contract at overrideSdkBoundary. Terminal line:
 *   VERDICT: PASS claude-sdk-oauth continuity matrix
 * Gate mode exits 1 on FAIL, naming the offending phase and turn.
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { safeDetail } from "./output-safety.mjs";
import { bootHermeticStack, resolveMatrixModels, SOURCE_ROOT } from "./claude-sdk-oauth-fullstack-harness.mjs";
import { assertMatrix } from "./claude-sdk-oauth-matrix-assert.mjs";
import { VERDICT_LABEL } from "./claude-sdk-oauth-matrix-constants.mjs";
import { MATRIX_PHASES } from "./claude-sdk-oauth-matrix-phases.mjs";
import { MatrixRun } from "./claude-sdk-oauth-matrix-run.mjs";

const MODEL_ID = "claude-haiku-4-5";
/** Phase (g) is the only fork boundary that runs; (f)/(i) are skipped, so add none. */
const EXPECTED_FORKS = 1;

function formatMatrixTable(turns) {
	const header = ["phase", "scenario", "turn", "queries", "budget", "payload", "bytes", "lineage", "obs", "status"];
	const rows = turns.map((turn) => [
		turn.phase,
		turn.label,
		String(turn.index),
		String(turn.queries),
		String(turn.expectations?.expectQueries ?? "-"),
		turn.kind,
		String(turn.bytes),
		`${String(turn.transcriptId).slice(0, 8)}${String(turn.lineage).includes("#") ? String(turn.lineage).slice(String(turn.lineage).indexOf("#")) : ""}`,
		turn.observations.map((observation) => `${observation.kind}:${observation.reason}`).join(",") || "-",
		turn.error ? "aborted" : "ok",
	]);
	const widths = header.map((label, column) => Math.max(label.length, ...rows.map((row) => row[column].length), 0));
	const line = (cells) =>
		cells
			.map((cell, column) => cell.padEnd(widths[column]))
			.join("  ")
			.trimEnd();
	return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line), ""].join("\n");
}

export async function runContinuityMatrix({ gate }) {
	let run;
	let stack;
	let session;
	let fatal;
	let infrastructureFailure;
	const observations = [];
	const skipped = [];

	try {
		stack = await bootHermeticStack({ onPayload: (entry) => run?.observePayload(entry) });
		const observabilityModule = await import(
			pathToFileURL(
				join(SOURCE_ROOT, "core", "extensions", "builtin", "claude-sdk-oauth", "session-observability.ts"),
			).href
		);
		observabilityModule.overrideContinuityObservabilityBoundary({
			emit: (observation) => observations.push(observation),
		});

		const created = await stack.createAgentSession();
		session = created.session;
		const models = resolveMatrixModels(session, MODEL_ID);
		await session.setModel(models.primary);
		run = new MatrixRun({ stack, session, models, observations });

		for (const phase of MATRIX_PHASES) {
			if (phase.skip) {
				skipped.push(phase);
				continue;
			}
			run.beginPhase(phase);
			await phase.run(run);
		}
	} catch (error) {
		fatal = error instanceof Error ? error : new Error(String(error));
		infrastructureFailure = /loopback|ECONNREFUSED|did not bind/i.test(fatal.message);
	} finally {
		// Close the resident SDK session BEFORE disposing/cleanup so the Claude Code
		// subprocess exits instead of recreating the sandbox behind us.
		await stack?.closeResidentSessions(session?.sessionManager?.getSessionId?.());
		try {
			session?.dispose?.();
		} catch {}
		try {
			stack?.registryModule.resetSessionRegistryBoundary();
		} catch {}
		await stack?.shutdown();
		try {
			stack?.authGuard.assertUnchanged();
		} catch (error) {
			fatal = error instanceof Error ? error : new Error(String(error));
		}
		stack?.box.cleanup();
	}

	if (infrastructureFailure) {
		process.stdout.write(`REJECTED signal=loopback_unreachable detail=${safeDetail(fatal.message)}\n`);
		return 2;
	}

	const turns = run?.turns ?? [];
	process.stdout.write(formatMatrixTable(turns));
	for (const phase of skipped) {
		process.stdout.write(`SKIPPED phase(${phase.id}) [${phase.label}] reason=${phase.skip}\n`);
	}

	const result = assertMatrix({
		turns,
		creations: stack?.creations ?? [],
		expectedForks: EXPECTED_FORKS,
		phases: MATRIX_PHASES,
	});
	const failures = [...result.failures];
	if (fatal) failures.unshift(`probe error: ${safeDetail(fatal.message)}`);
	if (turns.length === 0) failures.push("matrix ran no turns");

	const summary = result.summary;
	process.stdout.write(
		`SUMMARY turns=${summary.turns} queries=${summary.queries} budget=${summary.budget} ` +
			`unique_session_lineages=${summary.lineages} expected=${summary.expectedLineages} ` +
			`flatten_count=${summary.flattenCount} skipped=${skipped.map((phase) => phase.id).join(",") || "none"}\n`,
	);
	for (const detail of failures) process.stdout.write(`FAILURE ${detail}\n`);
	if (fatal) process.stderr.write(`PROBE ERROR: ${safeDetail(fatal.stack ?? fatal.message)}\n`);

	const passed = failures.length === 0;
	process.stdout.write(
		passed ? `VERDICT: PASS ${VERDICT_LABEL}\n` : `VERDICT: FAIL ${VERDICT_LABEL} — ${failures[0]}\n`,
	);
	return passed || !gate ? 0 : 1;
}
