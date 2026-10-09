import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { RequiredRuntime, RunPlan } from "./bench-run.ts";

const repSchema = Type.Object({
	cpuMs: Type.Number(),
	wallMs: Type.Number(),
	hostCpuMs: Type.Number(),
	kernelCpuMs: Type.Number(),
	p95Ms: Type.Optional(Type.Number()),
	observations: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
	),
});
const runtimeReportSchema = Type.Object({
	hostRuntime: Type.Union([Type.Literal("bun"), Type.Literal("node")]),
	hostVersion: Type.String(),
	runtimeVersion: Type.String(),
	loadavg: Type.Array(Type.Number()),
	scenarios: Type.Record(Type.String(), Type.Array(repSchema)),
});
export type RuntimeReport = Static<typeof runtimeReportSchema>;

export class BenchWorkerError extends Error {
	readonly name = "BenchWorkerError";
}

/** An idle worker does no benchmark work until its next request; only one worker is measured at a time. */
export function startWorker(plan: RunPlan, runtime: RequiredRuntime, target: string) {
	const host = runtime.jsRuntime ?? "bun";
	const prefix = host === "node" ? ["node", "--expose-gc", "--import", "tsx"] : ["bun"];
	const [command, ...prefixArgs] = prefix;
	if (!command) throw new BenchWorkerError("runtime command missing");
	const child = spawn(
		command,
		[
			...prefixArgs,
			resolve(plan.scriptRoot, "bench-runtime.ts"),
			target,
			runtime.language,
			String(plan.reps),
			"--stepped",
		],
		{ cwd: resolve(plan.scriptRoot, ".."), env: plan.env, stdio: ["pipe", "pipe", "pipe"] },
	);
	const replies = createInterface({ input: child.stdout });
	let pending: ReturnType<typeof Promise.withResolvers<RuntimeReport>> | undefined;
	let failure: BenchWorkerError | undefined;
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
	});
	const reject = (error: BenchWorkerError) => {
		failure = error;
		pending?.reject(error);
		pending = undefined;
	};
	child.once("error", (error) => reject(new BenchWorkerError(error.message)));
	child.stdin.on("error", (error) => reject(new BenchWorkerError(error.message)));
	replies.on("line", (line) => {
		if (!line.startsWith("BENCH_RUNTIME:")) return;
		try {
			const value: unknown = JSON.parse(line.slice("BENCH_RUNTIME:".length));
			if (!Check(runtimeReportSchema, value)) throw new BenchWorkerError("invalid runtime report");
			if (!pending) throw new BenchWorkerError("unsolicited runtime report");
			pending.resolve(value);
			pending = undefined;
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			reject(new BenchWorkerError(error.message));
		}
	});
	const exited = new Promise<number | null>((resolveExit) => {
		child.once("close", (code) => {
			if (pending || code !== 0) reject(new BenchWorkerError(`runtime exited ${code}: ${stderr.trim()}`));
			replies.close();
			resolveExit(code);
		});
	});
	return {
		async next(): Promise<RuntimeReport> {
			if (failure) throw failure;
			if (pending) throw new BenchWorkerError("concurrent measurement request");
			const reply = Promise.withResolvers<RuntimeReport>();
			pending = reply;
			child.stdin.write("\n");
			return await reply.promise;
		},
		async close(): Promise<void> {
			child.stdin.end();
			const code = await exited;
			if (failure) throw failure;
			if (code !== 0) throw new BenchWorkerError(`runtime exited ${code}: ${stderr.trim()}`);
		},
	};
}
