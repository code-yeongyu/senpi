#!/usr/bin/env node
/**
 * Real source-CLI proof for default-on cursor-cli-oauth native bootstrap.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/cursor-cli-oauth-auto-bootstrap-qa.mjs \
 *     --evidence cursor-cli-oauth-auto-bootstrap
 *
 * PASS requires:
 * - first startup has only a native `cursor` OAuth credential and no enabled
 *   setting, yet creates one canonical managed `native` account and completes
 *   a real source-CLI turn;
 * - a second startup remains one-slot/idempotent;
 * - explicit enabled:false prevents the copy and fallback turn;
 * - acknowledgement remains absent, native and real auth remain unchanged,
 *   stable argv receipts exist, and every sandbox is removed.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	runCli,
} from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";

const MODEL = "composer-2.5-fast";

function parseArgs(argv) {
	let evidence = "cursor-cli-oauth-auto-bootstrap";
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg !== "--evidence") throw new Error(`unknown argument: ${arg}`);
		const value = argv[++index];
		if (!value) throw new Error("--evidence requires a value");
		evidence = value;
	}
	return { evidence };
}

function digest16(value) {
	return value === null ? null : `${value.slice(0, 16)}…`;
}

function sha256(path) {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

function makeExecutable(root, box) {
	const fixture = join(root, "packages", "coding-agent", "test", "fixtures", "fake-cursor-agent.mjs");
	const catalogDump = join(box.dir, "catalog-invocation.json");
	const turnDump = join(box.dir, "turn-invocation.json");
	const executable = join(box.dir, "fake-cursor-agent");
	writeFileSync(
		executable,
		[
			"#!/bin/sh",
			`if [ "$1" = "models" ]; then dump=${JSON.stringify(catalogDump)}; else dump=${JSON.stringify(turnDump)}; fi`,
			`FAKE_CURSOR_ARGV_DUMP="$dump" FAKE_CURSOR_SCENARIO=happy exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(executable, 0o755);
	return { executable, catalogDump, turnDump };
}

function seed(box, enabled) {
	const native = {
		type: "oauth",
		access: "qa-native-access",
		refresh: "qa-native-refresh",
		expires: Date.now() + 3_600_000,
	};
	mkdirSync(box.agentDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(box.agentDir, "auth.json"), `${JSON.stringify({ cursor: native }, null, 2)}\n`, {
		mode: 0o600,
	});
	writeFileSync(
		join(box.agentDir, "settings.json"),
		`${JSON.stringify(
			{
				cursorCliOauthProvider: {
					executionMode: "plan",
					...(enabled === undefined ? {} : { enabled }),
				},
			},
			null,
			2,
		)}\n`,
	);
	return { native, nativeBefore: JSON.stringify(native) };
}

function readState(box, nativeBefore) {
	const auth = JSON.parse(readFileSync(join(box.agentDir, "auth.json"), "utf8"));
	const settings = JSON.parse(readFileSync(join(box.agentDir, "settings.json"), "utf8"));
	const accounts = auth["cursor-cli-oauth"]?.accounts ?? [];
	return {
		nativePreserved: JSON.stringify(auth.cursor) === nativeBefore,
		managedPresent: auth["cursor-cli-oauth"] !== undefined,
		accountCount: accounts.length,
		accountNames: accounts.map((account) => account.name),
		accountSource: accounts[0]?.source ?? null,
		accountMatchesNative:
			accounts[0]?.access === auth.cursor?.access && accounts[0]?.refresh === auth.cursor?.refresh,
		enabledField:
			Object.hasOwn(settings.cursorCliOauthProvider ?? {}, "enabled")
				? settings.cursorCliOauthProvider.enabled
				: null,
		acknowledged: settings.cursorCliOauthProvider?.noApprovalAcknowledgedAt !== undefined,
	};
}

async function runTurn(root, box, executable) {
	const env = {
		...hermeticEnv(box.env),
		SENPI_CURSOR_CLI_OAUTH_EXECUTABLE: executable,
	};
	const turn = await runCli(
		[
			"--provider",
			"cursor-cli-oauth",
			"--model",
			MODEL,
			"--print",
			"Reply with the deterministic fixture result.",
		],
		{ env, cwd: box.cwd, timeoutMs: 120_000 },
	);
	const combined = `${turn.stdout}\n${turn.stderr}`;
	return {
		code: turn.code,
		timedOut: turn.timedOut,
		resultMarker: combined.includes("STREAMTEST OK"),
		errorExcerpt: turn.code === 0 ? null : combined.trim().slice(0, 500),
	};
}

async function main() {
	const { evidence } = parseArgs(process.argv.slice(2));
	const root = repoRoot();
	const output = evidenceDir(evidence);
	const guard = guardRealAuth();
	installCleanupHooks();
	const enabledBox = makeSandbox("cursor-cli-auto-enabled");
	const disabledBox = makeSandbox("cursor-cli-auto-disabled");
	const removed = [];
	let result;
	try {
		const enabledSeed = seed(enabledBox, undefined);
		const enabledExecutable = makeExecutable(root, enabledBox);
		const firstTurn = await runTurn(root, enabledBox, enabledExecutable.executable);
		const firstState = readState(enabledBox, enabledSeed.nativeBefore);
		const secondTurn = await runTurn(root, enabledBox, enabledExecutable.executable);
		const secondState = readState(enabledBox, enabledSeed.nativeBefore);
		const turnInvocation = JSON.parse(readFileSync(enabledExecutable.turnDump, "utf8"));
		const catalogInvocation = existsSync(enabledExecutable.catalogDump)
			? JSON.parse(readFileSync(enabledExecutable.catalogDump, "utf8"))
			: null;

		const disabledSeed = seed(disabledBox, false);
		const disabledExecutable = makeExecutable(root, disabledBox);
		const disabledTurn = await runTurn(root, disabledBox, disabledExecutable.executable);
		const disabledState = readState(disabledBox, disabledSeed.nativeBefore);

		guard.assertUnchanged();
		writeFileSync(
			join(output, "invocation.json"),
			`${JSON.stringify(
				{
					turnArgv: turnInvocation.argv,
					turnEnvKeys: Object.keys(turnInvocation.env ?? {}).sort(),
					catalogArgv: catalogInvocation?.argv ?? null,
				},
				null,
				2,
			)}\n`,
		);
		result = {
			scenario: "cursor-cli-oauth-auto-bootstrap-qa",
			generatedAt: new Date().toISOString(),
			firstStart: { turn: firstTurn, state: firstState },
			secondStart: { turn: secondTurn, state: secondState },
			explicitDisabled: { turn: disabledTurn, state: disabledState },
			authGuard: {
				path: guard.path,
				before: digest16(guard.before),
				after: digest16(sha256(guard.path)),
				unchanged: true,
			},
			liveProbe: {
				status: "gated-skip",
				reason:
					"the real Senpi auth store has no native cursor credential; the hermetic source CLI proves the production bootstrap without mutating real auth",
			},
		};
		result.pass =
			firstTurn.code === 0 &&
			firstTurn.timedOut === false &&
			firstTurn.resultMarker === true &&
			firstState.nativePreserved === true &&
			firstState.managedPresent === true &&
			firstState.accountCount === 1 &&
			firstState.accountNames[0] === "native" &&
			firstState.accountSource === "import" &&
			firstState.accountMatchesNative === true &&
			firstState.enabledField === null &&
			firstState.acknowledged === false &&
			secondTurn.code === 0 &&
			secondTurn.resultMarker === true &&
			secondState.accountCount === 1 &&
			secondState.accountNames[0] === "native" &&
			secondState.nativePreserved === true &&
			disabledTurn.code !== 0 &&
			disabledTurn.timedOut === false &&
			disabledState.nativePreserved === true &&
			disabledState.managedPresent === false &&
			disabledState.enabledField === false &&
			turnInvocation.argv.includes("--model") &&
			turnInvocation.argv.includes(MODEL) &&
			turnInvocation.argv.includes("--mode") &&
			turnInvocation.argv.includes("plan");
		writeFileSync(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
		writeFileSync(
			join(output, "transcript.txt"),
			[
				`first.code=${firstTurn.code}`,
				`first.resultMarker=${firstTurn.resultMarker}`,
				`first.accountCount=${firstState.accountCount}`,
				`first.enabledField=${firstState.enabledField}`,
				`first.acknowledged=${firstState.acknowledged}`,
				`second.code=${secondTurn.code}`,
				`second.accountCount=${secondState.accountCount}`,
				`disabled.code=${disabledTurn.code}`,
				`disabled.managedPresent=${disabledState.managedPresent}`,
				`auth.unchanged=true`,
			].join("\n") + "\n",
		);
	} finally {
		for (const box of [enabledBox, disabledBox]) {
			box.cleanup();
			rmSync(box.dir, { recursive: true, force: true });
			removed.push({ dir: box.dir, removed: !existsSync(box.dir) });
		}
	}
	if (!result) throw new Error("scenario produced no result");
	result.cleanup = { sandboxes: removed, allRemoved: removed.every((entry) => entry.removed) };
	writeFileSync(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	const pass = result.pass === true && result.cleanup.allRemoved === true;
	process.stdout.write(
		`[${pass ? "PASS" : "FAIL"}] first=${result.firstStart.turn.code}/${result.firstStart.state.accountCount}; ` +
			`second=${result.secondStart.turn.code}/${result.secondStart.state.accountCount}; ` +
			`disabled=${result.explicitDisabled.turn.code}/${result.explicitDisabled.state.managedPresent}\n`,
	);
	process.stdout.write(`auth guard: UNCHANGED (${result.authGuard.before} -> ${result.authGuard.after})\n`);
	process.stdout.write(`cleanup: all sandboxes removed=${result.cleanup.allRemoved}\n`);
	process.stdout.write(`evidence: ${output}\n`);
	return pass ? 0 : 1;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`scenario failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
