/**
 * A REAL supervised host on Bun (the runtime a compiled omo engine runs), for the cases that depend on
 * Bun itself - a full collection, the supervisor's phys_footprint - and a footprint reader for any pid
 * that runs under Bun too, since the Node reader only reports RSS. Teardown goes through the endpoint
 * scratch: the supervisor is tracked, and the host child is reaped by sandbox path.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { hostLifecycleEntry } from "./rpc-generation-support.ts";
import { type EndpointScratch, hostArgs, hostEnv, trackSupervisor } from "./rpc-host-endpoint-scratch.ts";

const footprintModule = fileURLToPath(new URL("../../src/core/process-footprint.ts", import.meta.url));
const footprintSchema = z.object({ bytes: z.number(), measure: z.string() });

export async function bunHost(qa: EndpointScratch, socket: string, extension?: string): Promise<number> {
	const host = await ensureHost({
		socket,
		agentDir: qa.agentDir,
		policy: { idleExitMs: 600_000 },
		hostArgs: hostArgs(extension),
		env: { ...hostEnv(qa), SENPI_RUNTIME: "bun" },
		_test: {
			readinessTimeoutMs: 60_000,
			launch: (args) => ({ command: "bun", args: [hostLifecycleEntry(), ...args] }),
		},
	});
	trackSupervisor(host.pid);
	host.release();
	return host.pid;
}

export function bunFootprint(pid: number): Promise<{ bytes: number; measure: string } | undefined> {
	const script = `import { readProcessFootprint } from ${JSON.stringify(footprintModule)};
console.log(JSON.stringify(readProcessFootprint(${pid}) ?? null));`;
	return new Promise((resolveFootprint, reject) => {
		execFile("bun", ["-e", script], { encoding: "utf8", timeout: 30_000 }, (error, stdout) => {
			if (error) return reject(error);
			const parsed = footprintSchema.nullable().parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null"));
			resolveFootprint(parsed ?? undefined);
		});
	});
}

export async function bunFootprintBytes(pid: number): Promise<number | undefined> {
	return (await bunFootprint(pid))?.bytes;
}
