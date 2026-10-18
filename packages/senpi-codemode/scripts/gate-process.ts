import { spawn } from "node:child_process";

export type GateProcessResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

/** Completion is a process close event, never a sleep or a polling interval. */
export function runProcess(command: readonly string[], cwd: string): Promise<GateProcessResult> {
	const [file, ...args] = command;
	if (!file) throw new TypeError("Gate command is empty");
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
					!key.startsWith("PI_") && (!key.startsWith("SENPI_CODEMODE_") || key === "SENPI_CODEMODE_GATE_MUTATE"),
				)),
				SENPI_QA_REQUIRE_ALL_LANGUAGES: "1", CI: "1",
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
	});
}
