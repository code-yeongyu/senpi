import { readFileSync } from "node:fs";
import * as os from "node:os";

/** Snapshot of host facts rendered into the workstation block. */
export interface WorkstationFacts {
	/** `os.platform()`, e.g. `darwin`. */
	readonly osLine: string;
	/** Kernel identity: `<uname -s> <uname -r>`, e.g. `Darwin 25.3.0`. */
	readonly kernel: string;
	/** `os.arch()`, e.g. `arm64`. */
	readonly arch: string;
	/** CPU model plus logical core count, e.g. `Apple M5 Max (18 cores)`. */
	readonly cpu?: string;
	/** GPU model when cheaply derivable (Apple Silicon shares the SoC name). */
	readonly gpu?: string;
	/** Terminal emulator name/version from TERM_PROGRAM/TERM. */
	readonly terminal?: string;
}

/**
 * Wording dialect for the execution-context instruction under the facts.
 * Families follow the prompt-preset conventions: Claude/GLM take direct
 * imperatives in a tagged block, GPT (codex) takes terse bounded rules, Kimi
 * takes positive operational constraints (all-caps directives make K2.x
 * overthink), the `gemini` dialect takes one plain sentence pair (the
 * provider's guidance: direct instructions, no persuasive emphasis), and `default` is
 * the maximum-emphasis fallback for unmatched models.
 */
export type WorkstationDialect = "default" | "claude" | "codex" | "kimi" | "gemini";

// Kernel identity: `<uname -s> <uname -r>` (`Darwin 25.3.0`, `Linux 6.8.0-45-generic`).
// Deliberately NOT `os.version()` — Node returns the full xnu build string on
// macOS (noisy) and some runtimes return the literal "unknown", which makes
// models misidentify the host platform.

function cpuModel(): string | undefined {
	if (process.platform === "linux") {
		try {
			const cpuInfo = readFileSync("/proc/cpuinfo", "utf8");
			const match = /^model name\s*:\s*(.+)$/m.exec(cpuInfo);
			if (match?.[1]) return match[1].trim();
		} catch {
			// fall through to os.cpus()
		}
	}
	return os.cpus()[0]?.model?.trim() || undefined;
}

// GPU: only derivable without a subprocess on Apple Silicon, where the SoC
// name doubles as the GPU name. Other platforms would need nvidia-smi/lspci —
// deliberately skipped to keep prompt assembly synchronous.

function terminalName(env: NodeJS.ProcessEnv): string | undefined {
	const program = env.TERM_PROGRAM?.trim();
	if (program) {
		const version = env.TERM_PROGRAM_VERSION?.trim();
		return version ? `${program} ${version}` : program;
	}
	return env.TERM?.trim() || undefined;
}

/**
 * Test-only host pin (senpi#4660): `SENPI_TEST_WORKSTATION={"cpuModel":string,"cores":int,"kernel":string}`
 * replaces the CPU model, core count and kernel identity so a harness driving the real CLI gets the same prompt
 * bytes on every host. Unset (or empty) in every production launch.
 */
const WORKSTATION_ENV = "SENPI_TEST_WORKSTATION";

interface PinnedHost {
	readonly cpuModel: string;
	readonly cores: number;
	readonly kernel: string;
}

function pinnedHost(env: NodeJS.ProcessEnv): PinnedHost | undefined {
	const value = env[WORKSTATION_ENV];
	if (value === undefined || value === "") return undefined;
	const invalid = new Error(
		`${WORKSTATION_ENV} must be a JSON object {"cpuModel": non-empty string, "cores": positive integer, "kernel": non-empty string}, got ${JSON.stringify(value)}`,
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw invalid;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid;
	const fields = parsed as Record<string, unknown>;
	const { cpuModel, cores, kernel } = fields;
	const exactKeys = Object.keys(fields).sort().join(",") === "cores,cpuModel,kernel";
	if (
		!exactKeys ||
		typeof cpuModel !== "string" ||
		cpuModel === "" ||
		typeof kernel !== "string" ||
		kernel === "" ||
		typeof cores !== "number" ||
		!Number.isInteger(cores) ||
		cores < 1
	) {
		throw invalid;
	}
	return { cpuModel, cores, kernel };
}

/** Read host facts from `node:os` and `env`, honoring the test-only `SENPI_TEST_WORKSTATION` pin. Not cached. */
export function readWorkstationFacts(env: NodeJS.ProcessEnv = process.env): WorkstationFacts {
	const pinned = pinnedHost(env);
	const cpu = pinned ? pinned.cpuModel : cpuModel();
	const cores = pinned ? pinned.cores : os.availableParallelism();
	const gpu = process.platform === "darwin" && os.arch() === "arm64" && cpu?.startsWith("Apple ") ? cpu : undefined;
	const terminal = terminalName(env);
	return {
		osLine: os.platform(),
		kernel: pinned ? pinned.kernel : `${os.type()} ${os.release()}`.trim(),
		arch: os.arch(),
		...(cpu === undefined ? {} : { cpu: `${cpu} (${cores} cores)` }),
		...(gpu === undefined ? {} : { gpu }),
		...(terminal === undefined ? {} : { terminal }),
	};
}

let cachedFacts: WorkstationFacts | undefined;

/** Collect host facts once per process; every call after the first is free. */
export function collectWorkstationFacts(): WorkstationFacts {
	cachedFacts ??= readWorkstationFacts();
	return cachedFacts;
}

/** Subject + verb naming the local executors, e.g. "`bash` and `eval` execute". */
function executorPhrase(selectedTools: readonly string[]): string {
	const executors = ["bash", "eval"].filter((name) => selectedTools.includes(name));
	if (executors.length === 0) return "Everything you run executes";
	return `${executors.map((name) => `\`${name}\``).join(" and ")} execute${executors.length === 1 ? "s" : ""}`;
}

const INSTRUCTIONS: Record<WorkstationDialect, (executors: string) => string> = {
	claude: (executors) =>
		`<execution_context>
${executors} on THIS workstation. Match commands, paths, package managers, and parallel pool sizes to it. Code you write may target any machine; code you run always runs here.
</execution_context>`,
	codex: (executors) =>
		`${executors} on this workstation; match commands, paths, and parallelism to it. Written code may target other platforms: executed code runs here.`,
	kimi: (executors) =>
		`${executors} on this workstation: choose commands, paths, and parallelism that fit it. When writing code for another target platform, keep the code portable; only the execution happens here.`,
	gemini: (executors) =>
		`${executors} on this workstation; match commands, paths, package managers, and parallel pool sizes to it. Code you write may target another machine; code you run always runs here.`,
	default: (executors) =>
		`**EXECUTION HAPPENS HERE.** ${executors} on THIS machine: you MUST match commands, paths, package managers, and parallel pool sizes to the workstation above. Code you WRITE may target a different machine; anything you RUN executes HERE.`,
};

export interface BuildWorkstationSectionOptions {
	readonly selectedTools: readonly string[];
	readonly dialect?: WorkstationDialect;
	/** Override collected facts (tests). */
	readonly facts?: WorkstationFacts;
}

/** Render the `<workstation>` facts block plus the dialect-tuned execution-context instruction. */
export function buildWorkstationSection(options: BuildWorkstationSectionOptions): string {
	const facts = options.facts ?? collectWorkstationFacts();
	const dialect = options.dialect ?? "default";
	const lines = [
		`- OS: ${facts.osLine} (kernel ${facts.kernel})`,
		`- Arch: ${facts.arch}`,
		...(facts.cpu ? [`- CPU: ${facts.cpu}`] : []),
		...(facts.gpu ? [`- GPU: ${facts.gpu}`] : []),
		...(facts.terminal ? [`- Terminal: ${facts.terminal}`] : []),
	];
	const instruction = INSTRUCTIONS[dialect](executorPhrase(options.selectedTools));
	return `<workstation>\n${lines.join("\n")}\n</workstation>\n${instruction}`;
}
