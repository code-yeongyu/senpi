#!/usr/bin/env node
/**
 * Hermetic real-source-CLI proof for Cursor OAuth catalog activation.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/cursor-oauth-catalog-refresh-qa.mjs \
 *     --evidence cursor-oauth-catalog-refresh
 *
 * PASS requires:
 * - explicit `/cursor-account import native` behavior copies, never moves,
 *   the native `cursor` OAuth credential into canonical managed accounts;
 * - provider enablement, acknowledgement, and scoped availability refresh
 *   persist in the sandbox;
 * - the real Senpi source CLI completes a print turn through the hermetic
 *   fake cursor-agent fixture;
 * - the user's real auth store remains byte-identical and the sandbox is
 *   removed.
 */

import { spawnSync } from "node:child_process";
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
	let evidence = "cursor-oauth-catalog-refresh";
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

function runSetup(root, box) {
	const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
	const setup = join(
		root,
		".agents",
		"skills",
		"senpi-qa",
		"scripts",
		"scenarios",
		"cursor-oauth-catalog-refresh",
		"setup.ts",
	);
	const result = spawnSync(
		process.execPath,
		[tsx, "--tsconfig", join(root, "tsconfig.json"), setup, box.agentDir, box.cwd],
		{
			cwd: root,
			env: hermeticEnv(box.env),
			encoding: "utf8",
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`setup failed (status=${result.status}): ${(result.stderr ?? "").trim()}`);
	}
	return JSON.parse((result.stdout ?? "").trim());
}

async function main() {
	const { evidence } = parseArgs(process.argv.slice(2));
	const root = repoRoot();
	const evidencePath = evidenceDir(evidence);
	const box = makeSandbox("cursor-oauth-catalog-refresh");
	const guard = guardRealAuth();
	installCleanupHooks();
	let cleanupRemoved = false;
	let result;
	try {
		const setup = runSetup(root, box);
		const catalogArgvDump = join(box.dir, "fake-cursor-catalog-invocation.json");
		const turnArgvDump = join(box.dir, "fake-cursor-turn-invocation.json");
		const fixture = join(root, "packages", "coding-agent", "test", "fixtures", "fake-cursor-agent.mjs");
		const executable = join(box.dir, "fake-cursor-agent");
		writeFileSync(
			executable,
			[
				"#!/bin/sh",
				`if [ "$1" = "models" ]; then dump=${JSON.stringify(catalogArgvDump)}; else dump=${JSON.stringify(turnArgvDump)}; fi`,
				`FAKE_CURSOR_ARGV_DUMP="$dump" FAKE_CURSOR_SCENARIO=happy exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(executable, 0o755);
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
		const invocation = JSON.parse(readFileSync(turnArgvDump, "utf8"));
		const catalogInvocation = existsSync(catalogArgvDump)
			? JSON.parse(readFileSync(catalogArgvDump, "utf8"))
			: null;
		writeFileSync(
			join(evidencePath, "invocation.json"),
			`${JSON.stringify(
				{
					turnArgv: invocation.argv,
					turnEnvKeys: Object.keys(invocation.env ?? {}).sort(),
					catalogArgv: catalogInvocation?.argv ?? null,
				},
				null,
				2,
			)}\n`,
		);
		const cliPass =
			turn.code === 0 &&
			turn.timedOut === false &&
			combined.includes("STREAMTEST OK") &&
			invocation.argv.includes("--model") &&
			invocation.argv.includes(MODEL);
		guard.assertUnchanged();
		result = {
			scenario: "cursor-oauth-catalog-refresh-qa",
			generatedAt: new Date().toISOString(),
			setup,
			cli: {
				code: turn.code,
				timedOut: turn.timedOut,
				resultMarker: combined.includes("STREAMTEST OK"),
				requestedModel: MODEL,
				modelArgObserved: invocation.argv.includes(MODEL),
				stdoutExcerpt: turn.stdout.slice(0, 500),
				stderrExcerpt: turn.stderr.slice(0, 500),
			},
			liveProbe: {
				status: "gated-skip",
				reason:
					"the hermetic scenario never reads live credentials; run the existing cursor-cli-oauth live scenario with SENPI_CURSOR_CLI_LIVE=1",
			},
			authGuard: {
				path: guard.path,
				before: digest16(guard.before),
				after: digest16(sha256(guard.path)),
				unchanged: true,
			},
			pass:
				setup.nativePreserved === true &&
				setup.targetCreated === true &&
				setup.accountName === "native" &&
				setup.accountSource === "import" &&
				setup.accountMatchesNative === true &&
				setup.enabled === true &&
				setup.acknowledged === true &&
				setup.refreshRequested === true &&
				setup.successNotice === true &&
				setup.modelVisibleBeforeImport === false &&
				setup.modelVisibleAfterImport === true &&
				setup.postLoginCatalog?.allowNetworkObserved === true &&
				setup.postLoginCatalog?.catalogRequests === 1 &&
				setup.postLoginCatalog?.modelVisibleBefore === false &&
				setup.postLoginCatalog?.modelVisibleAfter === true &&
				cliPass,
		};
		writeFileSync(join(evidencePath, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
		writeFileSync(
			join(evidencePath, "transcript.txt"),
			[
				`setup.nativePreserved=${setup.nativePreserved}`,
				`setup.targetCreated=${setup.targetCreated}`,
				`setup.accountName=${setup.accountName}`,
				`setup.enabled=${setup.enabled}`,
				`setup.refreshRequested=${setup.refreshRequested}`,
				`setup.modelVisibleBeforeImport=${setup.modelVisibleBeforeImport}`,
				`setup.modelVisibleAfterImport=${setup.modelVisibleAfterImport}`,
				`setup.postLoginAllowNetwork=${setup.postLoginCatalog?.allowNetworkObserved}`,
				`setup.postLoginCatalogRequests=${setup.postLoginCatalog?.catalogRequests}`,
				`setup.postLoginModelVisibleBefore=${setup.postLoginCatalog?.modelVisibleBefore}`,
				`setup.postLoginModelVisibleAfter=${setup.postLoginCatalog?.modelVisibleAfter}`,
				`cli.code=${turn.code}`,
				`cli.timedOut=${turn.timedOut}`,
				`cli.resultMarker=${combined.includes("STREAMTEST OK")}`,
				`authGuard.unchanged=true`,
			].join("\n") + "\n",
		);
	} finally {
		box.cleanup();
		rmSync(box.dir, { recursive: true, force: true });
		cleanupRemoved = !existsSync(box.dir);
	}
	if (!result) throw new Error("scenario produced no result");
	result.cleanup = { sandbox: box.dir, removed: cleanupRemoved };
	writeFileSync(join(evidencePath, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(
		`[${result.pass && cleanupRemoved ? "PASS" : "FAIL"}] native copy preserved primary credential; ` +
			`target=${result.setup.accountName}; enabled=${result.setup.enabled}; refresh=${result.setup.refreshRequested}; ` +
			`post-login HTTP catalog=${result.setup.postLoginCatalog?.modelVisibleAfter}; CLI marker=${result.cli.resultMarker}\n`,
	);
	process.stdout.write(`auth guard: UNCHANGED (${result.authGuard.before} -> ${result.authGuard.after})\n`);
	process.stdout.write(`cleanup: sandbox removed=${cleanupRemoved}\n`);
	process.stdout.write(`evidence: ${evidencePath}\n`);
	return result.pass && cleanupRemoved ? 0 : 1;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`scenario failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
