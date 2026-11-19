import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attestSessionSpawn, getAgentDir } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { readKernelProcessIdentity } from "../../coding-agent/src/core/kernel-process-identity.ts";
import { resolvePidSession, sessionSpawnsDir } from "../../coding-agent/src/core/session-spawn-attestation.ts";
import { CHILD_LIFECYCLE_OP } from "../src/bridge/reserved.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { WorkerChildren } from "../src/kernels/js/worker-children.ts";
import { resolveJavaScriptProcessCommand, runtimeNameOf } from "../src/kernels/js/process-worker.ts";
import { NO_CELL_DEADLINE, parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";
import { hasPython3, liveKernel, runCell } from "./py-kernel/fixtures.ts";

/**
 * senpi#6972: a gate an agent runs from an eval cell (`Bun.$`, `child_process`, a python subprocess) must resolve to
 * the session whose kernel ran it, from the kernel's ancestry, whatever `PI_SESSION_ID` the command sets.
 */
const supported = process.platform === "linux" || process.platform === "darwin";
const SESSION = "eval-session-6972";
/** What the extension injects for a session (`session-manager.ts`): a record bound to the host's own session id. */
const attestSpawn = (pid: number) => attestSessionSpawn(SESSION, pid);
const attestationModule = fileURLToPath(
	new URL("../../coding-agent/src/core/session-spawn-attestation.ts", import.meta.url),
);

const bunChild = (() => {
	try {
		const command = resolveJavaScriptProcessCommand(undefined, process.platform, "bun", "");
		return runtimeNameOf(command) === "bun" ? command : undefined;
	} catch {
		return undefined;
	}
})();

async function recordWritten(pid: number): Promise<void> {
	const dir = sessionSpawnsDir(getAgentDir());
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${pid}.json`);
	const watcher = watch(dir);
	try {
		const appeared = new Promise<void>((resolve) => watcher.on("change", () => existsSync(path) && resolve()));
		if (existsSync(path)) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`no attestation record for pid ${pid}`)), 10_000);
		});
		await Promise.race([appeared, deadline]).finally(() => clearTimeout(timer));
	} finally {
		watcher.close();
	}
}

describe.skipIf(!supported)("eval kernel spawn attestation (#6972)", () => {
	const kernels: JavaScriptKernel[] = [];
	afterEach(async () => {
		await Promise.all(kernels.splice(0).map((kernel) => kernel.close()));
	});

	it.skipIf(bunChild === undefined)(
		"a Bun.$ command in a process kernel resolves to the calling session, even with a forged PI_SESSION_ID",
		async () => {
			const kernel = new JavaScriptKernel({
				sessionId: SESSION,
				cwd: process.cwd(),
				parallelPoolWidth: 2,
				isolation: "process",
				processExecPath: bunChild,
				sessionEnv: { PI_SESSION_ID: SESSION },
				attestSpawn,
			});
			kernels.push(kernel);
			await runJavaScriptCell(kernel, "return 1", NO_CELL_DEADLINE);
			const kernelPid = kernel.processPid;
			if (kernelPid === undefined) throw new Error("the process kernel reported no pid");
			await recordWritten(kernelPid);

			const dir = JSON.stringify(sessionSpawnsDir(getAgentDir()));
			const probe = `import { resolvePidSession } from ${JSON.stringify(attestationModule)}; console.log(JSON.stringify(await resolvePidSession(process.pid, { dir: ${dir} })));`;
			const run = await runJavaScriptCell(
				kernel,
				`return JSON.parse(await Bun.$\`env PI_SESSION_ID=forged-session ${bunChild} -e ${"${"}${JSON.stringify(probe)}}\`.text());`,
				NO_CELL_DEADLINE,
			);

			expect(parseJavaScriptResult(run.result)).toMatchObject({
				attested: true,
				sessionId: SESSION,
				attestedPid: kernelPid,
				hostPid: process.pid,
			});
		},
	);

	// A worker kernel runs on a host thread, so the Bun.spawn children it reports are the host's own children. The suite
	// host is Node, where a worker has no Bun.spawn; the reported event is driven at the host seam with a real child.
	it("a child a worker kernel reports is attested to its session until it exits", async () => {
		const sleeper = spawn("sleep", ["30"]);
		const pid = sleeper.pid;
		if (pid === undefined) throw new Error("the test child did not start");
		const children = new WorkerChildren(undefined, attestSpawn);
		try {
			children.track({ op: CHILD_LIFECYCLE_OP, pid, state: "spawned" });
			await recordWritten(pid);
			expect(await resolvePidSession(pid)).toMatchObject({ attested: true, sessionId: SESSION, attestedPid: pid });
		} finally {
			const exited = once(sleeper, "exit");
			sleeper.kill("SIGKILL");
			await exited;
			children.track({ op: CHILD_LIFECYCLE_OP, pid, state: "exited" });
		}
	});
});

describe.skipIf(!supported || !(await hasPython3()))("python kernel spawn attestation (#6972)", () => {
	it("a subprocess of the python kernel resolves to the calling session", async () => {
		const kernel = await liveKernel({ sessionEnv: { PI_SESSION_ID: SESSION }, attestSpawn });
		try {
			const started = await runCell(
				kernel,
				"import subprocess\n_sleeper = subprocess.Popen(['env', 'PI_SESSION_ID=forged', 'sleep', '30'])\n_sleeper.pid",
			);
			if (!started.ok || started.valueRepr === undefined) throw new Error("the subprocess pid was not returned");
			const pid = Number(started.valueRepr);
			const interpreter = (await readKernelProcessIdentity(pid))?.ppid;
			if (interpreter === undefined) throw new Error("the subprocess is gone");
			await recordWritten(interpreter);

			expect(await resolvePidSession(pid)).toMatchObject({
				attested: true,
				sessionId: SESSION,
				attestedPid: interpreter,
				chain: [pid, interpreter],
			});
			await runCell(kernel, "_sleeper.kill()");
		} finally {
			await kernel.close();
		}
	});
});
