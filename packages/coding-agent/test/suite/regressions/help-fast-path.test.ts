import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * `--help` used to boot the whole engine before it could print one line: migrations, the
 * settings manager, `ModelRuntime.create()` (models.json + models-store.json + availability),
 * the full resource load (extensions AND skills, prompt templates, themes, context files) and
 * an `AgentSession`. Measured cost of that boot for a help screen: 790ms warm on bun, 959ms on
 * node, 8.8-13.6s cold — and 47.8s for the reporter of oh-my-openagent#8371 on Windows.
 *
 * Help needs exactly two things: the static usage text and the flags extensions registered.
 * These tests pin that contract through observable side effects, never timings:
 * - a probe extension appends one line per factory invocation, so the line count IS the number
 *   of times extensions were loaded;
 * - `models-store.json` exists only if the model runtime was constructed;
 * - the project directory must stay untouched by a help screen.
 */

const CLI_PATH = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
// The child runs in a temp project directory, where a bare `tsx` specifier cannot resolve.
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function probeExtensionSource(flagName: string): string {
	return `import { appendFileSync } from "node:fs";

export default function helpProbeExtension(pi) {
	appendFileSync(process.env.SENPI_HELP_PROBE_REPORT, "loaded\\n");
	pi.registerFlag("${flagName}", {
		type: "boolean",
		default: false,
		description: "help fast path probe flag",
	});
}
`;
}

interface HelpRun {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly loads: number;
}

let hostDir: string;
let agentDir: string;
let projectDir: string;
let reportPath: string;

function runHelp(args: readonly string[] = ["--help"]): HelpRun {
	// A child spawned from inside an agent session inherits OMO_/SENPI_ agent-dir lanes and
	// SENPI_BRAND, and the OMO lane wins brand resolution; both must be dropped so the child
	// reads this test's temp agent directory (test/AGENTS.md quarantine contract).
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key === "SENPI_BRAND" || key.endsWith("_CODING_AGENT_DIR")) continue;
		env[key] = value;
	}
	env.NODE_OPTIONS = `--import ${TSX_LOADER_URL}`;
	env.SENPI_CODING_AGENT_DIR = agentDir;
	env.SENPI_HELP_PROBE_REPORT = reportPath;
	env.PI_OFFLINE = "1";

	const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
		encoding: "utf8",
		cwd: projectDir,
		env,
	});
	const loads = readFileSync(reportPath, "utf8")
		.split("\n")
		.filter((line) => line.length > 0).length;
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, loads };
}

beforeEach(() => {
	hostDir = mkdtempSync(join(tmpdir(), "senpi-help-fast-path-"));
	agentDir = join(hostDir, "agent");
	projectDir = join(hostDir, "project");
	reportPath = join(hostDir, "probe-report.txt");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(reportPath, "");
	writeFileSync(join(agentDir, "extensions", "help-probe.js"), probeExtensionSource("help-probe-alpha"));
});

afterEach(() => {
	rmSync(hostDir, { recursive: true, force: true });
});

describe("help fast path (oh-my-openagent#8371)", () => {
	describe("#given a first help run with no cached flags", () => {
		test("#when --help runs #then it prints usage plus extension flags without building the model runtime", () => {
			const run = runHelp();

			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toContain("Usage:");
			expect(run.stdout).toContain("--help-probe-alpha");
			expect(run.loads).toBe(1);
			// The model runtime is what writes this file; a help screen must never construct it.
			expect(existsSync(join(agentDir, "models-store.json"))).toBe(false);
			expect(readdirSync(projectDir)).toEqual([]);
		});
	});

	describe("#given help has already resolved the flags once", () => {
		test("#when --help runs again #then the same output is printed without loading extensions again", () => {
			const first = runHelp();
			expect(first.status, first.stderr).toBe(0);
			expect(first.loads).toBe(1);

			const second = runHelp();

			expect(second.status, second.stderr).toBe(0);
			expect(second.stdout).toContain("--help-probe-alpha");
			expect(second.stdout).toBe(first.stdout);
			// The cached answer must not re-enter extension loading.
			expect(second.loads).toBe(1);
		});
	});

	describe("#given an extension changed after the flags were cached", () => {
		test("#when --help runs #then the cache is rejected and the new flag is listed", () => {
			expect(runHelp().loads).toBe(1);
			writeFileSync(join(agentDir, "extensions", "help-probe.js"), probeExtensionSource("help-probe-beta"));

			const run = runHelp();

			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toContain("--help-probe-beta");
			expect(run.stdout).not.toContain("--help-probe-alpha");
			expect(run.loads).toBe(2);
		});
	});

	describe("#given a new extension appeared after the flags were cached", () => {
		test("#when --help runs #then the cache is rejected and both flags are listed", () => {
			expect(runHelp().loads).toBe(1);
			writeFileSync(join(agentDir, "extensions", "help-probe-2.js"), probeExtensionSource("help-probe-gamma"));

			const run = runHelp();

			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toContain("--help-probe-alpha");
			expect(run.stdout).toContain("--help-probe-gamma");
			expect(run.loads).toBe(3);
		});
	});

	describe("#given settings changed after the flags were cached", () => {
		test("#when --help runs #then the cache is rejected and extensions are loaded again", () => {
			expect(runHelp().loads).toBe(1);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));

			const run = runHelp();

			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toContain("--help-probe-alpha");
			expect(run.loads).toBe(2);
		});
	});

	describe("#given the project directory carries an extension the user never trusted", () => {
		test("#when --help runs #then the project extension is neither loaded nor listed", () => {
			const projectExtensionsDir = join(projectDir, ".senpi", "extensions");
			mkdirSync(projectExtensionsDir, { recursive: true });
			writeFileSync(join(projectExtensionsDir, "project-probe.js"), probeExtensionSource("project-probe-delta"));

			const first = runHelp();
			const second = runHelp();

			expect(first.status, first.stderr).toBe(0);
			expect(first.stdout).toContain("--help-probe-alpha");
			expect(first.stdout).not.toContain("--project-probe-delta");
			expect(first.loads).toBe(1);
			expect(second.stdout).toBe(first.stdout);
			expect(second.loads).toBe(1);
		});
	});

	describe("#given extensions are disabled for this run", () => {
		test("#when --help --no-extensions runs #then usage prints with no extension flags and no extension load", () => {
			const run = runHelp(["--help", "--no-extensions"]);

			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toContain("Usage:");
			expect(run.stdout).not.toContain("--help-probe-alpha");
			expect(run.loads).toBe(0);
		});
	});
});
