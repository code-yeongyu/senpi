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
 * overthink), and `default` is the maximum-emphasis fallback for unmatched
 * models.
 */
export type WorkstationDialect = "default" | "claude" | "codex" | "kimi";

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

function terminalName(): string | undefined {
	const program = process.env.TERM_PROGRAM?.trim();
	if (program) {
		const version = process.env.TERM_PROGRAM_VERSION?.trim();
		return version ? `${program} ${version}` : program;
	}
	return process.env.TERM?.trim() || undefined;
}

let cachedFacts: WorkstationFacts | undefined;

/** Collect host facts once per process; every call after the first is free. */
export function collectWorkstationFacts(): WorkstationFacts {
	if (cachedFacts) return cachedFacts;
	const cpu = cpuModel();
	const cores = os.availableParallelism();
	const gpu = process.platform === "darwin" && os.arch() === "arm64" && cpu?.startsWith("Apple ") ? cpu : undefined;
	const terminal = terminalName();
	const facts: WorkstationFacts = {
		osLine: os.platform(),
		kernel: `${os.type()} ${os.release()}`.trim(),
		arch: os.arch(),
		...(cpu === undefined ? {} : { cpu: `${cpu} (${cores} cores)` }),
		...(gpu === undefined ? {} : { gpu }),
		...(terminal === undefined ? {} : { terminal }),
	};
	cachedFacts = facts;
	return facts;
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
		`${executors} on this workstation; match commands, paths, and parallelism to it. Written code may target other platforms — executed code runs here.`,
	kimi: (executors) =>
		`${executors} on this workstation — choose commands, paths, and parallelism that fit it. When writing code for another target platform, keep the code portable; only the execution happens here.`,
	default: (executors) =>
		`**EXECUTION HAPPENS HERE.** ${executors} on THIS machine — you MUST match commands, paths, package managers, and parallel pool sizes to the workstation above. Code you WRITE may target a different machine; anything you RUN executes HERE.`,
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
