/**
 * The continuity contract. Every assertion is measured at overrideSdkBoundary —
 * the single choke point the resident and flatten paths share — so a
 * production regression on either path is caught here, not simulated.
 */

/** Formats one failure so the offending phase and turn are always named. */
function failure(turn, detail) {
	return `phase(${turn.phase}) turn ${turn.index} [${turn.label}]: ${detail}`;
}

function assertTurn(turn, failures) {
	const expect = turn.expectations ?? {};
	if (turn.error && expect.completes !== false) {
		failures.push(failure(turn, `turn failed: ${turn.error.message}`));
		return;
	}
	if (turn.kind === "flatten") {
		failures.push(failure(turn, "submitted a <conversation_history> flatten payload"));
	}
	if (turn.path === "flatten-stream") {
		failures.push(failure(turn, "ran on the non-resident flatten stream path"));
	}
	if (expect.expectQueries !== undefined && turn.queries !== expect.expectQueries) {
		failures.push(failure(turn, `created ${turn.queries} SDK queries, budget was ${expect.expectQueries}`));
	}
	// Reattach boundaries must resume the SAME lineage; fork boundaries must branch
	// it (forkSession + resumeSessionAt), which the SDK expresses as a resume of the
	// same transcript id, so the fork FLAG — not the id — is the discriminator.
	if (expect.expectLineage === "same") {
		if (turn.lineageChanged) failures.push(failure(turn, `lineage changed to ${turn.lineage} on a reattach boundary`));
		if (turn.forked) failures.push(failure(turn, "reattach boundary forked the lineage instead of resuming it"));
		if (turn.queries > 0 && !turn.resumedSameTranscript) {
			failures.push(failure(turn, "reattach boundary started a new session instead of resuming"));
		}
	}
	if (expect.expectLineage === "fork") {
		if (!turn.forked) failures.push(failure(turn, "fork boundary did not branch the lineage (forkSession absent)"));
		if (!turn.resumedSameTranscript) {
			failures.push(failure(turn, "fork boundary abandoned the transcript instead of branching it"));
		}
	}
	// Every post-bootstrap turn submits only the delta.
	if (turn.index > 1 && turn.payloads !== undefined && turn.kind !== "delta" && expect.completes !== false) {
		failures.push(failure(turn, `submitted a ${turn.kind} payload instead of the delta`));
	}
	// Exactly one continuity observation per completed turn.
	if (turn.completed && turn.observations.length !== 1) {
		failures.push(failure(turn, `emitted ${turn.observations.length} continuity observations, expected exactly 1`));
	}
}

export function assertMatrix({ turns, creations, expectedForks, phases }) {
	const failures = [];
	for (const turn of turns) assertTurn(turn, failures);

	const lineages = new Set(creations.map((record) => record.lineage ?? "none"));
	const expectedLineages = 1 + expectedForks;
	if (lineages.size !== expectedLineages) {
		failures.push(
			`unique_session_lineages=${lineages.size} but expected ${expectedLineages} (1 + ${expectedForks} fork(s))`,
		);
	}

	const flattenCount = turns.filter((turn) => turn.kind === "flatten").length;
	if (flattenCount !== 0) failures.push(`flatten_count=${flattenCount}, contract requires 0`);

	const budget = turns.reduce((total, turn) => total + (turn.expectations?.expectQueries ?? 0), 0);
	if (creations.length !== budget) {
		failures.push(`run-global queries=${creations.length} but the summed per-phase budget is ${budget}`);
	}

	const ranPhases = new Set(turns.map((turn) => turn.phase));
	for (const phase of phases) {
		if (!phase.skip && !ranPhases.has(phase.id)) failures.push(`phase(${phase.id}) [${phase.label}] ran no turns`);
	}

	return {
		failures,
		summary: {
			turns: turns.length,
			queries: creations.length,
			lineages: lineages.size,
			expectedLineages,
			flattenCount,
			budget,
		},
	};
}
