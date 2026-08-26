#!/usr/bin/env node
/**
 * Isolated real-PTY /resume scenario.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/tui-resume.mjs --messages 5000 --select latest --evidence resume-performance
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	guardRealAuth,
	makeSandbox,
	repoRoot,
} from "./lib/common.mjs";
import { hermeticEnv } from "./lib/mock-loop-support.mjs";
import { parseArgs, resolveResumeEvidence, SESSION_ID, usage, writeSession } from "./lib/tui-resume-args.mjs";
import { driveResume, spawnResumeTui } from "./lib/tui-resume-pty.mjs";
import { applyPostExitCleanup, teardownPty } from "./lib/tui-resume-teardown.mjs";
import { createResumeCleanupController } from "./lib/tui-resume-signal.mjs";
import { captureGridEvidence, isPng, writeResumeArtifacts } from "./lib/tui-resume-evidence.mjs";

async function main() {
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		usage();
		process.exit(2);
	}
	const options = parseArgs(argv);
	const root = repoRoot();
	const evidence = resolveResumeEvidence(root, options.evidence);
	const guard = guardRealAuth();
	const box = makeSandbox("tui-resume");
	let term;
	let stream;
	let ptyReceipt;
	const cleanupController = createResumeCleanupController({
		teardown: teardownPty,
		postExitCleanup: (receipt) =>
			applyPostExitCleanup(receipt, {
				removeSandbox: () => box.cleanup(),
				sandboxExists: () => existsSync(box.dir),
				assertAuth: () => guard.assertUnchanged(),
			}),
		prePtyCleanup: () => {
			box.cleanup();
			guard.assertUnchanged();
			return { ptyExited: false, sandboxRemoved: !existsSync(box.dir), authUnchanged: true };
		},
		exit: (code) => process.exit(code),
	});
	cleanupController.install();
	const actions = [];
	const cwd = realpathSync(box.cwd);
	const sessionPath = join(box.sessionDir, `2027-01-15T00-00-01-000Z_${SESSION_ID}.jsonl`);
	await writeSession(sessionPath, { sessionId: SESSION_ID, cwd, messageCount: options.messages });

	const env = hermeticEnv({
		...box.env,
		PI_SKIP_VERSION_CHECK: "1",
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	});
	({ term, stream } = await spawnResumeTui({ root, cwd, env }));
	cleanupController.registerPty(term, stream);
	let timing;
	let runError;
	try {
		timing = await driveResume(term, stream, { messages: options.messages, actions });
	} catch (error) {
		runError = error;
	} finally {
		ptyReceipt = await cleanupController.cleanup();
		if (ptyReceipt.teardownError) runError ??= new Error(ptyReceipt.teardownError);
		cleanupController.unregister();
	}

	const paths = writeResumeArtifacts(evidence, {
		raw: stream.raw,
		actions,
		timing,
		runError,
		options,
		sessionPath,
	});

	let gridAssert = { pass: false };
	try {
		gridAssert = captureGridEvidence(root, paths);
	} catch (error) {
		runError ??= error;
	}

	writeFileSync(join(evidence, "cleanup.json"), `${JSON.stringify(ptyReceipt, null, 2)}\n`);
	process.stdout.write(`CLEANUP_RECEIPT ${JSON.stringify(ptyReceipt)}\n`);
	process.stderr.write(`evidence: ${evidence}\n`);
	if (timing) process.stdout.write(`TIMING ${JSON.stringify(timing)}\n`);

	const gridPass = gridAssert.failed === 0 && gridAssert.total > 0;
	process.stdout.write(`[${gridPass ? "PASS" : "FAIL"}] final grid contains final marker\n`);
	if (runError) {
		process.stderr.write(`${runError instanceof Error ? runError.stack : String(runError)}\n`);
		process.exit(1);
	}
	if (!gridPass) process.exit(1);
	const seq = ptyReceipt.cleanupSequence ?? [];
	const ptyAt = seq.indexOf("ptyExited");
	if (
		!ptyReceipt.ptyExited ||
		!ptyReceipt.sandboxRemoved ||
		!ptyReceipt.authUnchanged ||
		ptyAt < 0 ||
		ptyAt >= seq.indexOf("sandboxRemoved") ||
		ptyAt >= seq.indexOf("authUnchanged")
	) {
		process.stderr.write(`cleanup failed: ${JSON.stringify(ptyReceipt)}\n`);
		process.exit(1);
	}
	if (!isPng(paths.pngPath)) {
		process.stderr.write("terminal.png is not a valid PNG\n");
		process.exit(1);
	}
	process.stdout.write(`[PASS] screenshot: ${paths.pngPath}\n`);
	process.stdout.write(`[PASS] cleanup: ${ptyReceipt.summary}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
