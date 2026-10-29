// EQ.tui cases (plan P0-05c, §6.4): the cases whose observables include O8 run again through the real interactive TUI,
// with the same spec (fixtures, scripted model turns, files) as their RPC run, and the TUI capture is compared against
// the B0 TUI goldens. Each drive below is the keyboard form of the case's RPC drive.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { FIXTURES, startCaseRun } from "../../scenarios/fused-equivalence/cases/support/case-run.mjs";
import { childRuntimeFacts, hostFacts } from "../../scenarios/fused-equivalence/cases/support/host.mjs";
import { resolveBun } from "./common.mjs";
import { createNormalizer } from "./equivalence-normalize.mjs";
import { findSessionFile, idle, startTui, tuiObservation } from "./equivalence-tui-capture.mjs";

const ESC = "\x1b";
const shows = (text) => (tui) => tui.screen().some((row) => row.includes(text));
/**
 * The first prompt's auto-title (a side request the fake server answers with "QA session") lands in the footer on its own
 * schedule; a checkpoint after a prompt waits for it, so the footer is the same in every run.
 */
const titled = shows("QA session");
/**
 * The per-run stats notice (`Cache hit …`, builtin tps.ts) is posted from an agent_end handler, so it can land after the
 * working indicator is gone. A wait after a turn that produced output counts it in the whole buffer, so the next submit or
 * checkpoint never races it (one notice per finished turn since boot or since compaction cleared the transcript).
 */
const noticed = (count) => (tui) => tui.lines().filter((line) => line.includes("Cache hit")).length >= count;
const settled = (text, notices) => (tui) => idle(tui) && titled(tui) && shows(text)(tui) && noticed(notices)(tui);

/** Boot the TUI (fresh or resumed) and wait until startup has finished, so a submit reaches the session. */
async function boot(run, options) {
	const tui = startTui(run, options);
	await tui.ready();
	return tui;
}

const BARRIER_TIMEOUT_MS = 120_000;
/** A body reached its barrier (bounded: a drive that never dispatches fails instead of hanging). */
function arrived(run, name) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`no tool body reached barrier ${name}`)), BARRIER_TIMEOUT_MS);
	});
	return Promise.race([run.server.barrierArrived(name), timeout]).finally(() => clearTimeout(timer));
}

/** Release held barriers in order, each once its result row is on screen (the TUI form of held.mjs releaseInOrder). */
async function releaseShown(run, tui, steps) {
	for (const { barrier, shown } of steps) {
		await arrived(run, barrier);
		run.server.releaseBarrier(barrier);
		await tui.waitFor(shows(shown), `${barrier} result`);
	}
}

const TUI_DRIVES = {
	async E01(run) {
		const tui = await boot(run);
		await tui.submit("read a.txt, b.txt and c.txt");
		await Promise.all(["read-a", "read-b", "read-c"].map((name) => arrived(run, name)));
		await releaseShown(run, tui, [
			{ barrier: "read-a", shown: "alpha" },
			{ barrier: "read-b", shown: "bravo" },
			{ barrier: "read-c", shown: "charlie" },
		]);
		await tui.checkpoint("final", settled("E01-DONE", 1));
	},
	async E04(run) {
		const e04 = join(FIXTURES, "e04");
		const command = (kind) =>
			[process.execPath, join(e04, "shell-hook.mjs"), kind, join(run.box.cwd, "trace.log")]
				.map((part) => JSON.stringify(part))
				.join(" ");
		const setup = spawnSync(
			resolveBun().command,
			[join(e04, "write-hooks.ts"), run.box.cwd, command("pre"), command("post")],
			{
				encoding: "utf8",
			},
		);
		if (setup.status !== 0) throw new Error(`write-hooks.ts failed: ${setup.stderr}`);
		const tui = await boot(run);
		await tui.submit("run qa twice");
		await tui.checkpoint("final", settled("E04-DONE", 1));
	},
	async E09(run) {
		const tui = await boot(run);
		await tui.submit("write a file");
		await arrived(run, "abort-1");
		tui.write(ESC);
		await tui.checkpoint("final", settled("eq_write", 1));
	},
	async E12(run) {
		const tui = await boot(run);
		for (const [message, marker, notices] of [
			["first", "E12-FIRST", 1],
			["second", "E12-SECOND", 2],
			["third", "E12-THIRD", 3],
		]) {
			await tui.submit(message);
			await tui.waitFor(settled(marker, notices), marker);
		}
		await tui.submit("/compact");
		await tui.checkpoint("vetoed", settled("Compaction cancelled", 3));
		await tui.submit("/compact");
		await tui.checkpoint("compacted", settled("compacted from", 0));
	},
	async E14(run) {
		const tui = await boot(run);
		await tui.submit("write a file");
		await arrived(run, "kill-1");
		run.sessionFile = findSessionFile(run.box.sessionDir);
		await tui.kill();
		const resumed = await boot(run, { resume: true });
		await resumed.checkpoint("resumed", idle);
		await resumed.submit("continue");
		// A resumed session asks for no title (only a session's first prompts are titled), so no footer title to wait for.
		await resumed.checkpoint("final", (t) => idle(t) && shows("E14-RESUMED")(t) && noticed(1)(t));
	},
	async E17(run) {
		run.server.releaseBarrier("open-call_by_client");
		run.server.releaseBarrier("open-call_by_other");
		const tui = await boot(run);
		await tui.submit("write two files");
		for (const call of ["call_by_client", "call_by_other"]) {
			await tui.checkpoint(`ask ${call}`, shows("\u2192 Allow once"), () => tui.selectorFence("\u2192 Allow once"));
			tui.write("\r");
			await tui.waitFor((t) => !shows("Allow once")(t), `${call} answered`);
		}
		await tui.checkpoint("final", settled("E17-DONE", 1));
	},
};

/** Spec changes the TUI form of a case needs: E17 asks through today's `ask` permission preset in the TUI itself. */
const TUI_SETTINGS = { E17: { permissionPreset: "ask" } };

export const TUI_CASE_IDS = Object.freeze(Object.keys(TUI_DRIVES));

/** The normalizer observe.mjs builds for a case run (§6.2): run-scoped roots and host facts, nothing else. */
function normalizerFor(run) {
	return createNormalizer({
		roots: [
			{ prefix: run.box.dir, token: "<sandbox>" },
			{ prefix: run.box.dir.replaceAll("/", "-"), token: "<sandbox-key>" },
			{ prefix: run.repo, token: "<repo>" },
			{ prefix: run.server.origin, token: "<model-server>" },
			{ prefix: run.server.origin.replace(/^http:\/\//, ""), token: "<model-server-host>" },
			...run.extraRoots,
		],
		hostFacts: [...hostFacts(), ...childRuntimeFacts(run.childRuntime)],
	});
}

/** Run one case through the TUI; returns its O8 TUI observation and the session file for the witness reader. */
export async function runTuiCase(testCase, env) {
	const drive = TUI_DRIVES[testCase.id];
	if (!drive) throw new Error(`${testCase.id} has no TUI drive (EQ.tui cases: ${TUI_CASE_IDS.join(", ")})`);
	const spec = typeof testCase.spec === "function" ? testCase.spec() : testCase.spec;
	const settings = TUI_SETTINGS[testCase.id] ? { ...spec.settings, ...TUI_SETTINGS[testCase.id] } : spec.settings;
	const run = await startCaseRun({
		...spec,
		settings,
		label: `tui-${testCase.id.toLowerCase()}`,
		env: { ...spec.env, ...env },
	});
	try {
		await drive(run);
		run.sessionFile ??= findSessionFile(run.box.sessionDir);
		return { observations: { O8: tuiObservation(run, normalizerFor(run)) }, sessionFile: run.sessionFile };
	} finally {
		await run.stop();
		run.box.cleanup();
	}
}
