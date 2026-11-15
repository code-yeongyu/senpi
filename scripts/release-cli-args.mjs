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
		"  --tested-sha <sha>",
		"                  Release the commit the forced-suite matrix jobs tested",
		"                  (publish-npm.yml, force_tests). HEAD must be that commit:",
		"                  --sha itself, or one catalog-only commit on top of it.",
		"                  Skips the catalog regeneration and the suite. Needs --sha",
		"                  and --shard-results.",
		"  --shard-results <dir>",
		"                  The matrix jobs' result files; every one must have passed",
		"                  on --tested-sha.",
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
		testedSha: null,
		shardResults: null,
	};
	const valueOptions = { "--sha": "sha", "--version": "version", "--tested-sha": "testedSha", "--shard-results": "shardResults" };
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
	if (args.testedSha !== null) {
		if (args.sha === null) fail("--tested-sha needs --sha, the dispatched commit the tested one must descend from");
		if (args.shardResults === null) fail("--tested-sha needs --shard-results, the forced-suite matrix jobs' result files");
		if (args.forceTests) fail("--tested-sha and --force-tests exclude each other: the suite already ran in the matrix jobs");
	} else if (args.shardResults !== null) {
		fail("--shard-results is read only with --tested-sha");
	}
	return args;
}
