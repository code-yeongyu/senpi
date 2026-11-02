// senpi#3566 todo 4 (review HIGH 1): under the child runtime the virtual child_process module keeps the builtin's
// shape - the same export keys, the builtin's classes and objects, and `promisify(exec)` resolving { stdout, stderr }
// through the gate.
import realChildProcess, { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BarrierClock } from "./barrier-clock.ts";
import { createGatedChildProcess } from "./gated-child-process.ts";
import {
	CHILD_PROCESS_LAUNCH_FUNCTIONS,
	childProcessVirtualModule,
	installChildProcessModule,
} from "./gated-modules.ts";
import { WorkerLaunchClient, type WorkerLaunchMessage } from "./worker-launch.ts";

afterEach(() => installChildProcessModule(realChildProcess));

function gatedModule() {
	const messages: WorkerLaunchMessage[] = [];
	const client = new WorkerLaunchClient({
		clockBuffer: BarrierClock.create(4).buffer,
		post: (message) => messages.push(message),
		jobId: () => "j1",
		skipAckWait: true,
	});
	return { gated: createGatedChildProcess(realChildProcess, client), messages };
}

describe("child_process virtual module under the child runtime", () => {
	it("exports exactly the builtin's keys, and every non-launch export is the builtin's own object", () => {
		const virtual = childProcessVirtualModule();
		expect(Object.keys(virtual).sort()).toEqual([...Object.keys(realChildProcess), "default"].sort());
		expect(virtual.ChildProcess).toBe(ChildProcess);
		const launch = new Set<string>(CHILD_PROCESS_LAUNCH_FUNCTIONS);
		for (const [name, value] of Object.entries(realChildProcess))
			if (!launch.has(name)) expect(virtual[name], name).toBe(value);
	});

	it("keeps promisify(exec) resolving { stdout, stderr } through the gated module, and the launch is recorded", async () => {
		const { gated, messages } = gatedModule();
		installChildProcessModule(gated);
		const virtual = childProcessVirtualModule();
		const exec = virtual.exec;
		if (typeof exec !== "function") throw new Error("exec is not a function");
		const execAsync = promisify(exec);
		expect(await execAsync("echo hi")).toEqual({ stdout: "hi\n", stderr: "" });
		expect(messages.find((message) => message.kind === "launch")).toMatchObject({ request: { api: "cp.spawn" } });
	});

	it("rejects a failed promisified exec with stdout and stderr attached, like Node", async () => {
		const { gated } = gatedModule();
		await expect(promisify(gated.exec)("echo out; echo err >&2; exit 3")).rejects.toMatchObject({
			stdout: "out\n",
			stderr: "err\n",
			code: 3,
		});
	});
});
