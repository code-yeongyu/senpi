import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const fixture = new URL("./issue-2951-holder-fixture.mjs", import.meta.url);

export async function startSessionHolder(sessionFile: string, sessionId: string, cwd: string | null) {
	const root = dirname(sessionFile);
	const child = spawn(
		process.execPath,
		["--import", "tsx", fileURLToPath(fixture), sessionFile, sessionId, ...(cwd === null ? [] : [cwd])],
		{
			cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, SENPI_CODING_AGENT_DIR: join(root, "agent") },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const exited = once(child, "exit");
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-2000);
	});
	try {
		const [chunk] = await Promise.race([
			once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) }),
			exited.then(([code, signal]) => {
				throw new Error(`Holder exited before publication: code=${code} signal=${signal}; ${stderr}`);
			}),
		]);
		expect(String(chunk)).toBe("HELD\n");
	} catch (cause) {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exited;
		throw cause;
	}
	const pid = child.pid;
	if (pid === undefined) throw new Error("Holder did not start");
	return {
		pid,
		async stop(crash = false) {
			if (child.exitCode !== null || child.signalCode !== null) return;
			if (crash) child.kill("SIGKILL");
			else child.stdin.end("release\n");
			await exited;
		},
		async [Symbol.asyncDispose]() {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill();
				await exited;
			}
		},
	};
}
