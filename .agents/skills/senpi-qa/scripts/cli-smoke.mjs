/**
 * Channel 4 — CLI smoke QA (auxiliary, non-interactive, no model calls).
 *
 * Fast checks for the command surface: --help text, --version, offline model
 * listing, and unknown-flag handling. Use this when you change CLI flags, help
 * output, or the non-interactive entry — it's the cheapest channel and needs no
 * provider. For agent-loop behavior use rpc-drive / mock-loop.
 *
 * Usage:
 *   node cli-smoke.mjs --self-test
 */

import { createChecks, guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "./lib/common.mjs";

async function selfTest() {
	installCleanupHooks();
	const checks = createChecks("cli-smoke.mjs --self-test");
	const guard = guardRealAuth();
	const box = makeSandbox("cli-smoke");
	const opts = { env: box.env, cwd: box.cwd, timeoutMs: 60000 };

	const help = await runCli(["--help"], opts);
	checks.ok(
		"--help prints usage with flags",
		help.code === 0 && help.stdout.includes("Usage:") && help.stdout.includes("--mode"),
		`code=${help.code}`,
	);

	checks.ok(
		"--help omits the gated --neo flag by default",
		help.code === 0 && !help.stdout.includes("--neo"),
		`code=${help.code}`,
	);

	const helpNeo = await runCli(["--help"], { ...opts, env: { ...box.env, SENPI_ENABLE_NEO: "1" } });
	checks.ok(
		"--help lists --neo when SENPI_ENABLE_NEO is set",
		helpNeo.code === 0 && helpNeo.stdout.includes("--neo"),
		`code=${helpNeo.code}`,
	);

	const version = await runCli(["--version"], opts);
	checks.ok("--version prints a version", version.code === 0 && /\d+\.\d+/.test(version.stdout), version.stdout.trim());

	const models = await runCli(["--list-models"], opts);
	checks.ok(
		"--list-models lists built-in models offline (no API)",
		models.code === 0 && models.stdout.split("\n").filter((l) => l.trim()).length >= 5,
		`lines=${models.stdout.split("\n").filter((l) => l.trim()).length}`,
	);

	// Use a genuinely unknown SHORT option: unknown long (--foo) flags are routed to
	// the extension-flag channel by design, but an unknown short option must error.
	const bad = await runCli(["-zzz"], opts);
	checks.ok(
		"unknown option is reported, not silently ignored",
		(bad.stdout + bad.stderr).includes("Unknown option"),
		`code=${bad.code}`,
	);

	checks.ok("real auth unchanged", (() => {
		try {
			return guard.assertUnchanged();
		} catch {
			return false;
		}
	})(), guard.path);

	box.cleanup();
	process.exit(checks.finish() ? 0 : 1);
}

if (process.argv[2] === "--self-test") {
	selfTest();
} else {
	process.stdout.write("senpi-qa Channel 4 — CLI smoke\n  node cli-smoke.mjs --self-test\n");
}
