import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Runs one console probe script under bun and returns its single JSON line. Each result is also appended to
// $SENPI_CONSOLE_PROBE_RESULTS so the Windows CI job can print the raw measurements.
export type Attachment = { readonly attached: boolean; readonly windowVisible: boolean };
const BUN = process.versions.bun ? process.execPath : "bun";
const RESULTS_FILE = process.env.SENPI_CONSOLE_PROBE_RESULTS;

export function fixture(name: string): string {
	return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

export async function runConsoleProbe<T>(script: string, args: readonly string[]): Promise<T> {
	const probe = spawn(BUN, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stdout = "";
	let stderr = "";
	probe.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	probe.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const [code] = (await once(probe, "close")) as [number | null];
	if (code !== 0) throw new Error(`${script} ${args.join(" ")} exited ${String(code)}: ${stderr.trim()}`);
	if (RESULTS_FILE) appendFileSync(RESULTS_FILE, `${stdout.trim()}\n`);
	return JSON.parse(stdout.trim()) as T;
}
