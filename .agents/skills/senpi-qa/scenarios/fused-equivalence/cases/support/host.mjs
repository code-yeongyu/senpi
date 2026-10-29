// Host identity for the normalizer and the golden key.
//
// The CLI renders the machine it runs on into its prompt (packages/coding-agent/src/core/dynamic-prompt/workstation.ts:
// kernel, CPU, GPU). Those values name the runner, like the sandbox path does, so they are replaced by tokens. What the
// CLI does differently per platform (which lines exist, which tools register) is behavior, so goldens are keyed by
// `<platform>-<arch>` and never shared across platforms.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import { childRuntime } from "../../../../scripts/lib/common.mjs";

function cpuModel() {
	if (process.platform === "linux") {
		try {
			const match = /^model name\s*:\s*(.+)$/m.exec(readFileSync("/proc/cpuinfo", "utf8"));
			if (match?.[1]) return match[1].trim();
		} catch {}
	}
	return os.cpus()[0]?.model?.trim() || undefined;
}

/** `<platform>-<arch>`: the golden directory a run on this host compares against. */
export const goldenPlatform = () => `${process.platform}-${process.arch}`;

/** The host facts the CLI renders, as normalizer `hostFacts` entries (longest values are replaced first). */
export function hostFacts() {
	const cpu = cpuModel();
	const facts = [
		{ value: `${os.type()} ${os.release()}`.trim(), token: "<host:kernel>" },
		{ value: os.release(), token: "<host:release>" },
	];
	if (cpu) {
		facts.push({ value: `${cpu} (${os.availableParallelism()} cores)`, token: "<host:cpu>" });
		facts.push({ value: cpu, token: "<host:cpu-model>" });
	}
	facts.push({ value: ` ${os.availableParallelism()} cores`, token: " <host:cores> cores" });
	// Where the runtimes are installed names the machine and its user, like the CPU does: the CLI child's executable
	// (a tool result's `runtime.path`) and the harness's own node.
	const child = childRuntime();
	if (child.kind !== "binary")
		for (const value of new Set([child.command, runtimeExecPath(child.command)]))
			facts.push({ value, token: `<host:${child.kind}-path>` });
	facts.push({ value: process.execPath, token: "<host:node-path>" });
	return facts;
}

let execPaths;
/**
 * The executable a runtime reports for itself (`process.execPath`), which is what the CLI puts in a tool result's
 * `runtime.path`. It differs from the resolved command when the command is a version-manager shim.
 */
function runtimeExecPath(command) {
	execPaths ??= new Map();
	if (!execPaths.has(command))
		execPaths.set(
			command,
			execFileSync(command, ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }).trim(),
		);
	return execPaths.get(command);
}

/**
 * The runtime the CLI child runs on, as the CLI names it to the model (`bun 1.4.4`, `node 24.22.1`): like the host
 * facts it identifies the run, not its behavior. `label` is common.mjs's `child_runtime` (`bun@1.4.4`).
 */
export function childRuntimeFacts(label) {
	const match = /^(bun|node)@(.+)$/.exec(label);
	return match ? [{ value: `${match[1]} ${match[2]}`, token: "<child-runtime>" }] : [];
}
