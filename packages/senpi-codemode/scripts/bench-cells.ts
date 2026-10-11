import type { EvalLanguage } from "../src/tool/types.ts";

type PerLanguage = Readonly<Record<EvalLanguage, string>>;

const MIB = 1024 * 1024;
export const SPILL_LINES = 160;
export const SPILL_LINE_BYTES = 65_535;
export const ALLOCATION_BYTES = 150 * MIB;
export const DATASET_SIZE = 20_000;

function quoted(value: string): string {
	return JSON.stringify(value);
}

export const scalarCell: PerLanguage = { js: "1 + 1", py: "1 + 1", rb: "1 + 1", jl: "1 + 1" };

/** Interpreter identity; the embedded clock is diagnostic only. CPU is read host-side after this result. */
export const cpuProbeCell: PerLanguage = {
	js: "0",
	py: 'f\'{__import__("os").getpid()},{__import__("time").process_time_ns() // 1000}\'',
	rb: '"#{Process.pid},#{Process.clock_gettime(Process::CLOCK_PROCESS_CPUTIME_ID, :microsecond)}"',
	jl: 'string(getpid(), ",", ccall(:clock, Clong, ()))',
};

export const versionCell: PerLanguage = {
	js: "process.versions.bun ?? process.versions.node",
	py: "__import__('platform').python_version()",
	rb: "RUBY_VERSION",
	jl: "string(VERSION)",
};

export const collectionCell: PerLanguage = {
	js: `if (process.versions.bun) (await import("bun")).gc(true); else { (await import("node:v8")).setFlagsFromString("--expose_gc"); (await import("node:vm")).runInNewContext("gc")(); } "collected"`,
	py: `__import__("gc").collect()\n"collected"`,
	rb: `GC.start; "collected"`,
	jl: `GC.gc(); "collected"`,
};

export const INTERRUPT_READY = "bench-interrupt-ready";
export const interruptCell: PerLanguage = {
	js: `console.log("${INTERRUPT_READY}"); await new Promise((resolve) => setTimeout(resolve, 30000))`,
	py: `__import__("__main__").text("stdout", "${INTERRUPT_READY}")\n__import__("time").sleep(30)`,
	rb: `puts "${INTERRUPT_READY}"; $stdout.flush; sleep 30`,
	jl: `print("${INTERRUPT_READY}\\n"); sleep(30)`,
};

export const futureCapabilityCell: PerLanguage = {
	js: `[typeof wait === "function" ? "wait" : "", typeof packages === "object" ? "install" : ""].join(",")`,
	py: `",".join(k for k, v in [("wait", callable(globals().get("wait"))), ("install", "packages" in globals()), ("callback", "__call__" in vars(type(tool)))] if v)`,
	rb: `[respond_to?(:wait, true) ? "wait" : "", defined?(packages) ? "install" : ""].join(",")`,
	jl: `join([isdefined(@__MODULE__, :wait) && wait !== Base.wait ? "wait" : "", isdefined(@__MODULE__, :packages) ? "install" : ""], ",")`,
};

export function sleepCell(language: EvalLanguage, seconds: number): string {
	switch (language) {
		case "js":
			return `await new Promise((resolve) => setTimeout(resolve, ${seconds * 1000}))`;
		case "py":
			return `import time\ntime.sleep(${seconds})`;
		case "rb":
			return `sleep ${seconds}`;
		case "jl":
			return `sleep(${seconds})`;
	}
}

export function readCell(language: EvalLanguage, path: string): string {
	const file = quoted(path);
	switch (language) {
		case "js":
			return `(await tool.read({ path: ${file} })).text.length`;
		case "py":
			return `len(tool.read({"path": ${file}})["text"])`;
		case "rb":
			return `tool.read({"path" => ${file}})["text"].length`;
		case "jl":
			return `length(tool.read(Dict("path" => ${file}))["text"])`;
	}
}

export function composeCell(language: EvalLanguage, batch: number): string {
	switch (language) {
		case "js":
			return `(await parallel([0, 1, 2, 3].map((j) => () => tool.echo({ n: ${batch} * 4 + j })))).map((r) => r.text).join(",")`;
		case "py":
			return `",".join(r["text"] for r in parallel([(lambda j=j: tool.echo({"n": ${batch} * 4 + j})) for j in range(4)]))`;
		case "rb":
			return `parallel((0..3).map { |j| -> { tool.echo({"n" => ${batch} * 4 + j}) } }).map { |r| r["text"] }.join(",")`;
		case "jl":
			return `join([r["text"] for r in parallel([() -> tool.echo(Dict("n" => ${batch} * 4 + j)) for j in 0:3])], ",")`;
	}
}

export const datasetCell: PerLanguage = {
	js: `globalThis.benchData = Array.from({ length: ${DATASET_SIZE} }, (_, i) => i); benchData.length`,
	py: `bench_data = list(range(${DATASET_SIZE}))\nlen(bench_data)`,
	rb: `$bench_data = (0...${DATASET_SIZE}).to_a; $bench_data.length`,
	jl: `global bench_data = collect(0:${DATASET_SIZE - 1}); bench_query(k) = sum(v % k for v in bench_data); length(bench_data)`,
};

export function queryCell(language: EvalLanguage, query: number): string {
	const modulus = (query % 7) + 2;
	switch (language) {
		case "js":
			return `benchData.reduce((sum, value) => sum + (value % ${modulus}), 0)`;
		case "py":
			return `sum(v % ${modulus} for v in bench_data)`;
		case "rb":
			return `$bench_data.sum { |v| v % ${modulus} }`;
		case "jl":
			return `bench_query(${modulus})`;
	}
}

export const spillCell: PerLanguage = {
	js: `for (let i = 0; i < ${SPILL_LINES}; i++) console.log("x".repeat(${SPILL_LINE_BYTES})); "spilled"`,
	py: `for _ in range(${SPILL_LINES}):\n    __import__("__main__").text("stdout", "x" * ${SPILL_LINE_BYTES} + "\\n")\n"spilled"`,
	rb: `${SPILL_LINES}.times { $stdout.write("x" * ${SPILL_LINE_BYTES} + "\\n") }; "spilled"`,
	jl: `for _ in 1:${SPILL_LINES}; print(repeat("x", ${SPILL_LINE_BYTES}) * "\\n"); end; "spilled"`,
};

export const allocateCell: PerLanguage = {
	js: `globalThis.benchBig = new Float64Array(${ALLOCATION_BYTES / 8}).fill(1); undefined`,
	py: `bench_big = b"\\x01" * ${ALLOCATION_BYTES}\nNone`,
	rb: `$bench_big = "x" * ${ALLOCATION_BYTES}; nil`,
	jl: `global bench_big = Vector{UInt8}(undef, ${ALLOCATION_BYTES}); ccall(:memset, Ptr{Cvoid}, (Ptr{Cvoid}, Cint, Csize_t), bench_big, 1, ${ALLOCATION_BYTES}); nothing`,
};

export const dropCell: PerLanguage = {
	js: `delete globalThis.benchBig; "dropped"`,
	py: `del bench_big\n"dropped"`,
	rb: `$bench_big = nil; "dropped"`,
	jl: `global bench_big = nothing; "dropped"`,
};

/** Kills the kernel from inside a scheduled event rather than inline, with nothing else running. */
export const crashCell: PerLanguage = {
	js: `setTimeout(() => { throw new Error("bench crash"); }); await new Promise(() => {})`,
	py: `import os, threading\nthreading.Timer(0, lambda: os._exit(70)).start()\nimport time\ntime.sleep(30)`,
	rb: `Thread.new { exit!(70) }; sleep 30`,
	jl: `@async ccall(:_exit, Cvoid, (Cint,), 70); sleep(30)`,
};

/** Identifies the kernel generation that ran a cell; a replacement reports a new value. */
export const generationCell: PerLanguage = {
	js: `globalThis.benchGeneration ??= Math.random().toString(36).slice(2)`,
	py: `__import__("os").getpid()`,
	rb: `Process.pid`,
	jl: `getpid()`,
};
