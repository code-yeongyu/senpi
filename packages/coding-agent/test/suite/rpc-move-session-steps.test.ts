/**
 * One failure injection per durable step of `MOVE_STEPS` (senpi#4004). Each step is hit two ways: a crash (the files are
 * put back exactly as they were at that step, so no catch handler's write survives) and a throw (the caller sees the
 * error and its catch handlers run). Then a client's realistic follow-ups replay (repeat the call that failed, ask
 * status with and without the path, finish the sender, delete the receiver's copy, import again here and elsewhere),
 * and after each the rules of the table must hold: at most one writable copy, the record agrees with the files, and a
 * revoke mark is never lost.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultSessionDir, loadEntriesFromFile } from "../../src/core/session-manager.ts";
import { MOVE_STEPS, type MoveStep, setMoveStepHook } from "../../src/core/session-move/move-steps.ts";
import { sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, exportedForB, move, type Rig } from "./rpc-move-session-support.ts";
import { admittedInputs } from "./session-move-fixture.ts";

type Fixture = Awaited<ReturnType<typeof devices>>;
type Answer = { readonly state: string; readonly revoked?: boolean };

class StepFault extends Error {}

afterEach(() => setMoveStepHook(undefined));

const writable = (file: string) => existsSync(file) && sessionOwnership(loadEntriesFromFile(file)).writable;
const landedFor = (file: string, moveId: string) =>
	existsSync(file) &&
	loadEntriesFromFile(file).some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "session_moved_in" &&
			(entry.data as { move_id?: unknown } | undefined)?.move_id === moveId,
	);

/** The files a crash leaves: both devices' session folders and move folders (lock files belong to the dead process). */
function durableDirs(fixture: Fixture): string[] {
	return [fixture.agentA, fixture.agentB].flatMap((agent) => [join(agent, "sessions"), join(agent, "session-moves")]);
}

function snapshot(fixture: Fixture): () => void {
	const saved = durableDirs(fixture).map((dir, index) => {
		const copy = join(fixture.base, `crash-${index}`);
		rmSync(copy, { recursive: true, force: true });
		const existed = existsSync(dir);
		if (existed) cpSync(dir, copy, { recursive: true, filter: (source) => !source.endsWith(".lock") });
		return { dir, copy, existed };
	});
	return () => {
		for (const { dir, copy, existed } of saved) {
			rmSync(dir, { recursive: true, force: true });
			if (existed) cpSync(copy, dir, { recursive: true });
		}
	};
}

/** Runs `action` with a fault at `step`: a crash restores the files as they were there, a throw keeps what ran. */
async function inject(fixture: Fixture, step: MoveStep, mode: "crash" | "throw", action: () => Promise<unknown>) {
	let restore: (() => void) | undefined;
	let fired = false;
	setMoveStepHook((reached) => {
		if (reached !== step || fired) return;
		fired = true;
		if (mode === "crash") restore = snapshot(fixture);
		throw new StepFault(step);
	});
	await action().catch(() => undefined);
	setMoveStepHook(undefined);
	restore?.();
	expect(fired, `the flow never reached ${step}`).toBe(true);
}

interface Copies {
	readonly sender: string;
	readonly here: string;
	readonly elsewhere: string;
}

function copiesOf(fixture: Fixture): Copies {
	const name = basename(fixture.sessionPath);
	return {
		sender: fixture.sessionPath,
		here: join(getDefaultSessionDir(fixture.repoB, fixture.agentB), name),
		elsewhere: join(getDefaultSessionDir(fixture.repoA, fixture.agentB), name),
	};
}

function expectOneWriterAtMost(copies: Copies, label: string) {
	const writers = [copies.sender, copies.here, copies.elsewhere].filter(writable);
	expect(writers.length, `${label}: writable copies ${writers.join(", ")}`).toBeLessThanOrEqual(1);
}

function expectAgreement(answer: Answer, copies: Copies, moveId: string, deleted: boolean, label: string) {
	const receiverWritable = [copies.here, copies.elsewhere].some(writable);
	if (answer.state === "accepted" && answer.revoked === true)
		expect(receiverWritable, `${label}: revoked but a receiver copy is writable`).toBe(false);
	else if (answer.state === "accepted" && !deleted)
		expect(writable(copies.here), `${label}: accepted but no writable landed copy`).toBe(true);
	else if (answer.state === "failed" || answer.state === "declined")
		expect(receiverWritable, `${label}: ${answer.state} beside a writable receiver copy`).toBe(false);
	else if (answer.state === "receiving")
		expect(
			landedFor(copies.here, moveId) || landedFor(copies.elsewhere, moveId),
			`${label}: receiving after a landing`,
		).toBe(false);
}

async function status(b: Rig, moveId: string, copies: Copies, deleted: boolean, label: string): Promise<Answer> {
	const answer = (await move(b, { op: "status", moveId })).data as Answer;
	expectAgreement(answer, copies, moveId, deleted, label);
	if (existsSync(copies.here))
		expect(
			(await move(b, { op: "status", moveId, sessionPath: copies.here })).data,
			`${label}: status with the path`,
		).toEqual(answer);
	return answer;
}

interface Run {
	readonly fixture: Fixture;
	readonly a: Rig;
	readonly b: Rig;
	readonly moveId: string;
	readonly copies: Copies;
}

async function imported(run: Run): Promise<void> {
	const bundleDir = await exportedForB(run.a, run.b, run.fixture, run.moveId, ["keep me"]);
	expect(await move(run.b, { op: "import", bundleDir, cwd: run.fixture.repoB, from: "device-a" })).toMatchObject({
		success: true,
	});
}

const bundleOf = (run: Run) => join(run.fixture.agentA, "session-moves", "outgoing", run.moveId);
const importInto = (run: Run, cwd: string) =>
	move(run.b, { op: "import", bundleDir: bundleOf(run), cwd, from: "device-a" });

async function withRun(moveId: string, body: (run: Run) => Promise<void>): Promise<void> {
	const fixture = await devices();
	await using a = createInProcessRig(fixture.agentA);
	await using b = createInProcessRig(fixture.agentB);
	await body({ fixture, a, b, moveId, copies: copiesOf(fixture) });
}

describe("move_session survives a fault at every durable step (senpi#4004)", () => {
	for (const row of MOVE_STEPS.filter((candidate) => candidate.flow !== "finish")) {
		for (const mode of ["crash", "throw"] as const) {
			for (const deleted of [false, true]) {
				it(`#given a ${mode} at ${row.step}${deleted ? " and the receiver's copy deleted" : ""} #then the table's rules hold through the follow-ups`, async () => {
					await withRun(`move-${row.step.replace(":", "-")}`, async (run) => {
						const label = `${row.step}/${mode}${deleted ? "/deleted" : ""}`;
						if (row.flow === "import") {
							const bundleDir = await exportedForB(run.a, run.b, run.fixture, run.moveId, ["keep me"]);
							await inject(run.fixture, row.step, mode, () =>
								move(run.b, { op: "import", bundleDir, cwd: run.fixture.repoB, from: "device-a" }),
							);
						} else {
							await imported(run);
							await inject(run.fixture, row.step, mode, () =>
								move(run.b, { op: "revoke", sessionPath: run.copies.here, moveId: run.moveId }),
							);
							expect(
								await status(run.b, run.moveId, run.copies, false, `${label}: before the repeated revoke`),
								`${label}: the revoke mark was lost`,
							).toEqual({ state: "accepted", revoked: true });
							expect(
								await move(run.b, { op: "revoke", sessionPath: run.copies.here, moveId: run.moveId }),
							).toMatchObject({ success: true });
						}
						expectOneWriterAtMost(run.copies, `${label}: after the fault`);
						if (deleted) rmSync(run.copies.here, { force: true });
						if (row.flow === "import") await importInto(run, run.fixture.repoB);
						expectOneWriterAtMost(run.copies, `${label}: after the retry`);

						const answer = await status(run.b, run.moveId, run.copies, deleted, label);
						expect(answer.state, `${label}: still receiving after the retry`).not.toBe("receiving");
						if (row.flow === "revoke") expect(answer).toEqual({ state: "accepted", revoked: true });
						expect(
							await move(run.a, { op: "finish", sessionPath: run.copies.sender, moveId: run.moveId, answer }),
						).toMatchObject({ success: true });
						await importInto(run, run.fixture.repoA);
						expectOneWriterAtMost(run.copies, `${label}: after finish and an import elsewhere`);
						const writers = [run.copies.sender, run.copies.here, run.copies.elsewhere].filter(writable);
						if (!deleted) expect(writers, `${label}: the session ended with no writable copy`).toHaveLength(1);
						await status(run.b, run.moveId, run.copies, deleted, `${label}: at the end`);
					});
				});
			}
		}
	}

	for (const row of MOVE_STEPS.filter((candidate) => candidate.flow === "finish")) {
		for (const mode of ["crash", "throw"] as const) {
			for (const revoked of [false, true]) {
				it(`#given a ${mode} at ${row.step} of a finish ${revoked ? "taking the session back" : "moving it"} #then a repeated finish settles it once`, async () => {
					const settle = async (step: MoveStep | undefined) => {
						let inputs: string[] = [];
						await withRun(`move-${revoked ? "back" : "on"}`, async (run) => {
							await imported(run);
							if (revoked) await move(run.b, { op: "revoke", sessionPath: run.copies.here, moveId: run.moveId });
							const answer = (await move(run.b, { op: "status", moveId: run.moveId })).data as Answer;
							const finish = () =>
								move(run.a, { op: "finish", sessionPath: run.copies.sender, moveId: run.moveId, answer });
							if (step !== undefined) await inject(run.fixture, step, mode, finish);
							expect(await finish()).toMatchObject({ success: true });
							expect(existsSync(bundleOf(run))).toBe(false);
							expect(writable(run.copies.sender)).toBe(revoked);
							expect(writable(run.copies.here)).toBe(!revoked);
							expectOneWriterAtMost(run.copies, `${row.step}/${mode}`);
							inputs = admittedInputs(run.copies.sender);
						});
						return inputs;
					};
					expect(await settle(row.step)).toEqual(await settle(undefined));
					if (revoked) expect(await settle(undefined)).toEqual(["keep me"]);
				});
			}
		}
	}
});
