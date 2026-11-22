/** `release.mjs`'s usage text and argument parsing (moved out of `release.mjs`, senpi#6642). */

export function printUsage() {
	const text = [
		"Usage: node scripts/release.mjs [options]",
		"",
		"Releases the senpi monorepo using CalVer (YYYY.M.D or YYYY.M.D-N).",
		"",
		"Options:",
		"  --version <v>   Explicit CalVer version. Must match",
		"                  /^\\d{4}\\.\\d{1,2}\\.\\d{1,2}(-\\d+)?$/ — for example 2026.5.13",
		"                  or 2026.5.13-2.",
		"  --dry-run       Preview every shell command and file write; modify nothing.",
		"                  Read-only git/npm reads (status, branch, tag --list,",
		"                  npm view) still execute so the plan is accurate.",
		"  --sha <sha>     Release this exact commit (40 hex chars, must be on main)",
		"                  instead of main's tip; later main merges stay out of the tag.",
		"  --force-tests   Run the CI=1 npm test suite in this job instead of",
		'                  reusing the release commit\'s green "Check and test" CI run.',
		"  --shard-results <dir>",
		"                  Release --sha on the forced-suite matrix jobs' result files",
		"                  (publish-npm.yml, force_tests): every one must have passed on",
		"                  --sha, and HEAD must be --sha. Skips the suite and the CI wait.",
		"  --ci-basis-receipt <id>",
		"                  Skip the wait for the hosted \"Check and test\" run: the",
		"                  release workflow accepted this CI-basis receipt for the",
		"                  pinned --sha (publish-npm.yml, ci_basis_receipt). Needs --sha.",
		"  --help, -h      Show this help and exit.",
		"",
		"Default flow: compute next version via scripts/calver.mjs, then release.",
	].join("\n");
	process.stdout.write(`${text}\n`);
}

function fail(message) {
	process.stderr.write(`[release] error: ${message}\n`);
	process.exit(1);
}

export function parseArgs(argv) {
	const args = {
		dryRun: false,
		version: null,
		help: false,
		forceTests: false,
		sha: null,
		shardResults: null,
		ciBasisReceipt: null,
	};
	const valueOptions = { "--sha": "sha", "--version": "version", "--shard-results": "shardResults", "--ci-basis-receipt": "ciBasisReceipt" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			args.help = true;
		} else if (arg === "--force-tests") {
			args.forceTests = true;
		} else if (arg === "--dry-run") {
			args.dryRun = true;
		} else if (arg in valueOptions) {
			i += 1;
			if (i >= argv.length) fail(`${arg} requires an argument`);
			args[valueOptions[arg]] = argv[i];
		} else {
			fail(`unknown argument: ${arg}`);
		}
	}
	if (args.shardResults !== null) {
		if (args.sha === null) fail("--shard-results needs --sha, the commit the forced-suite matrix jobs tested");
		if (args.forceTests) fail("--shard-results and --force-tests exclude each other: the suite already ran in the matrix jobs");
	}
	if (args.ciBasisReceipt !== null) {
		// senpi#6859: the workflow accepted the receipt for one pinned commit; it waives only that commit's hosted CI wait.
		if (args.ciBasisReceipt.trim() === "" || args.ciBasisReceipt !== args.ciBasisReceipt.trim()) {
			fail("--ci-basis-receipt is blank or has leading or trailing whitespace");
		}
		if (args.sha === null) fail("--ci-basis-receipt needs --sha, the pinned commit the receipt covers");
		if (args.forceTests || args.shardResults !== null) {
			fail("--ci-basis-receipt waives the hosted CI wait, which --force-tests and --shard-results releases do not have");
		}
	}
	return args;
}
