import { execFileSync } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, "..");

function printHelp() {
	console.log(`Usage:
  node packages/coding-agent/scripts/bench-reload.mjs [options]

Benchmarks DefaultResourceLoader.reload() from source (packages/coding-agent/src/core/resource-loader.ts)
against N synthetic extensions in an isolated temporary agent dir.

Each fresh probe process performs 1 warmup reload (the cold first call, reported
separately) followed by --runs measured reloads. This is repeated across --procs
fresh processes. The probe runs via \`node --import tsx\` so the real jiti import
path is exercised (same technique as test/resource-loader.test.ts).

Options:
  --ext-count <n>   Number of synthetic extensions to generate (default: 40)
  --runs <n>        Measured reloads per process (default: 10)
  --procs <n>       Fresh probe processes (default: 3)
  --out <path>      Write JSON results to this path
  --help            Show this help

Notes:
  - Always uses an isolated temp agent dir; never touches the real ~/.senpi.
  - Forces PI_OFFLINE=1 / PI_SKIP_VERSION_CHECK=1 in probe processes.
  - The bundled codemode extension is disabled via settings.json
    (disabledBuiltinExtensions) so measurements isolate the synthetic extensions.
`);
}

function parseIntegerFlag(value, name) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`Invalid ${name}: ${value}`);
	}
	return parsed;
}

function parseArgs(argv) {
	const options = {
		extCount: 40,
		runs: 10,
		procs: 3,
		out: undefined,
		help: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];

		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		if (
			(arg === "--ext-count" || arg === "--runs" || arg === "--procs" || arg === "--out") &&
			index + 1 >= argv.length
		) {
			throw new Error(`Missing value for ${arg}`);
		}

		if (arg === "--ext-count") {
			options.extCount = parseIntegerFlag(argv[++index], "--ext-count");
			continue;
		}

		if (arg === "--runs") {
			options.runs = parseIntegerFlag(argv[++index], "--runs");
			continue;
		}

		if (arg === "--procs") {
			options.procs = parseIntegerFlag(argv[++index], "--procs");
			continue;
		}

		if (arg === "--out") {
			options.out = resolve(argv[++index]);
			continue;
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function generateExtensions(extensionsDir, extCount) {
	mkdirSync(extensionsDir, { recursive: true });
	for (let index = 0; index < extCount; index++) {
		const name = `bench-ext-${String(index).padStart(3, "0")}`;
		writeFileSync(
			join(extensionsDir, `${name}.ts`),
			`export default function(pi) {
	pi.registerCommand("${name}", {
		description: "synthetic benchmark extension ${index}",
		handler: async () => {},
	});
}
`,
		);
	}
}

function writeProbe(probePath, runs) {
	const resourceLoaderUrl = pathToFileURL(join(packageDir, "src", "core", "resource-loader.ts")).href;
	writeFileSync(
		probePath,
		`import { performance } from "node:perf_hooks";
import { DefaultResourceLoader } from ${JSON.stringify(resourceLoaderUrl)};

const [agentDir, cwd, runsArg] = process.argv.slice(2);
const runs = Number.parseInt(runsArg, 10);

void (async () => {
	const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });

	// Cold first call: first reload() in this fresh process. Discarded from warm stats.
	const coldStart = performance.now();
	await loader.reload();
	const coldFirstMs = performance.now() - coldStart;

	const warm = [];
	for (let index = 0; index < runs; index++) {
		const start = performance.now();
		await loader.reload();
		warm.push(performance.now() - start);
	}

	const { extensions, errors } = loader.getExtensions();
	process.stdout.write(
		JSON.stringify({
			coldFirstMs,
			warm,
			extensionsLoaded: extensions.filter((extension) => !extension.path.startsWith("<builtin:")).length,
			errors,
		}),
	);
})();
`,
	);
}

function percentile(sortedValues, p) {
	if (sortedValues.length === 0) {
		return Number.NaN;
	}
	const rank = Math.ceil((p / 100) * sortedValues.length);
	return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, rank - 1))];
}

function summarize(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	return {
		min: sorted[0],
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted[sorted.length - 1],
		avg: total / sorted.length,
	};
}

function formatMs(value) {
	return `${value.toFixed(1)}ms`;
}

function runProbeProcess(probePath, agentDir, cwd, tempRoot, runs) {
	const output = execFileSync(process.execPath, ["--import", "tsx", probePath, agentDir, cwd, String(runs)], {
		cwd: packageDir,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: tempRoot,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
		},
		maxBuffer: 64 * 1024 * 1024,
	});
	return JSON.parse(output);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	const tempRoot = mkdtempSync(join(tmpdir(), "bench-reload-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	const probePath = join(tempRoot, "bench-reload-probe.mts");

	try {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		// Match the test convention: disable the bundled codemode extension through the real
		// global-settings mechanism so measurements isolate the synthetic extensions.
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ disabledBuiltinExtensions: ["codemode"] })}\n`,
		);
		generateExtensions(join(agentDir, "extensions"), options.extCount);
		writeProbe(probePath, options.runs);

		const runs = [];
		for (let procIndex = 0; procIndex < options.procs; procIndex++) {
			const result = runProbeProcess(probePath, agentDir, cwd, tempRoot, options.runs);
			if (result.errors.length > 0) {
				throw new Error(`Probe ${procIndex + 1} reported extension errors: ${JSON.stringify(result.errors)}`);
			}
			if (result.extensionsLoaded !== options.extCount) {
				throw new Error(
					`Probe ${procIndex + 1} loaded ${result.extensionsLoaded} extensions, expected ${options.extCount}`,
				);
			}
			runs.push({ proc: procIndex + 1, coldFirstMs: result.coldFirstMs, warmMs: result.warm });
			process.stdout.write(
				`[proc ${procIndex + 1}] cold first=${formatMs(result.coldFirstMs)} warm=[${result.warm.map(formatMs).join(", ")}]\n`,
			);
		}

		const allWarm = runs.flatMap((run) => run.warmMs);
		const coldFirsts = runs.map((run) => run.coldFirstMs);
		const warmSummary = summarize(allWarm);
		const coldSummary = summarize(coldFirsts);

		const result = {
			warmP50: warmSummary.p50,
			warmP95: warmSummary.p95,
			coldFirstMs: coldSummary.p50,
			runs,
			env: {
				node: process.version,
				platform: `${process.platform} ${process.arch}`,
				cpu: cpus()[0]?.model ?? "unknown",
				extCount: options.extCount,
			},
		};

		process.stdout.write("\nDefaultResourceLoader.reload() benchmark\n");
		process.stdout.write(`  extensions:       ${options.extCount} synthetic (isolated agent dir)\n`);
		process.stdout.write(`  processes:        ${options.procs} fresh x (1 cold + ${options.runs} warm)\n`);
		process.stdout.write(`  node:             ${result.env.node} on ${result.env.platform} (${result.env.cpu})\n`);
		process.stdout.write("\n");
		process.stdout.write(`  cold first call:  p50 ${formatMs(coldSummary.p50)}  min ${formatMs(coldSummary.min)}  max ${formatMs(coldSummary.max)}\n`);
		process.stdout.write(`  warm reload:      p50 ${formatMs(warmSummary.p50)}  p95 ${formatMs(warmSummary.p95)}  avg ${formatMs(warmSummary.avg)}  min ${formatMs(warmSummary.min)}  max ${formatMs(warmSummary.max)}\n`);

		if (options.out) {
			mkdirSync(dirname(options.out), { recursive: true });
			writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
			process.stdout.write(`\nWrote ${options.out}\n`);
		}
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
