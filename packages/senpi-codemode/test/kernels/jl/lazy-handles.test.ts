import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../../../src/bridge/http-server.ts";
import { type BridgeMessage, decodeBridgeFrame } from "../../../src/bridge/protocol.ts";
import { JuliaKernel, type JuliaKernelStartOptions } from "../../../src/kernels/jl/kernel.ts";

const execute = promisify(execFile);
const assets = fileURLToPath(new URL("../../../src/kernels/jl/", import.meta.url));
const counters = `
const SENPI_TEST_INCLUDES = Ref(0)
const SENPI_TEST_DECLARATIONS = Ref(0)
const SENPI_TEST_BLOCK_INCLUDE = Ref(false)
const SENPI_TEST_ENTERED = Channel{Nothing}(2)
const SENPI_TEST_RELEASE = Channel{Nothing}(2)
`;
const record = 'Dict("kind" => "agent", "id" => "st_first", "run_epoch" => 0)';

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-jl-lazy-handles-"));
	try {
		await mkdir(join(root, "cwd"));
		await Promise.all(["runner.jl", "prelude.jl"].map((name) => copyFile(join(assets, name), join(root, name))));
		await writeFile(
			join(root, "handles.jl"),
			`SENPI_TEST_INCLUDES[] += 1
if SENPI_TEST_BLOCK_INCLUDE[]
    put!(SENPI_TEST_ENTERED, nothing)
    take!(SENPI_TEST_RELEASE)
end
Base.include(Main, ${JSON.stringify(join(assets, "handles.jl"))}) do expression
    SENPI_TEST_DECLARATIONS[] += 1
    expression
end
`,
		);
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function withKernel(
	root: string,
	run: (kernel: JuliaKernel) => Promise<void>,
	connection = { port: 1, token: "test-only" },
	options: Pick<JuliaKernelStartOptions, "memory"> & {
		readonly onFrame?: (message: BridgeMessage) => void;
	} = {},
): Promise<void> {
	const probe = join(root, "probe.jl");
	await writeFile(probe, `${counters}\nBase.include(Main, ${JSON.stringify(join(root, "runner.jl"))})\n`);
	const kernel = JuliaKernel.start({
		...options,
		cwd: join(root, "cwd"),
		sessionId: "lazy-handles",
		connection,
		spawn: (command, args, context) => {
			const child = spawn(command, ["--threads=2", ...args.slice(0, -1), probe], {
				...context,
				detached: true,
				stdio: "pipe",
			});
			if (options.onFrame) {
				const frames = createInterface({ input: child.stdout });
				frames.on("line", (line) => {
					const decoded = decodeBridgeFrame(line);
					if (decoded.ok) options.onFrame?.(decoded.message);
				});
				child.once("exit", () => frames.close());
			}
			return child;
		},
	});
	try {
		await run(kernel);
	} finally {
		await kernel.close();
	}
}

async function value(kernel: JuliaKernel, code: string): Promise<unknown> {
	const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 60_000 });
	if (!result.ok) throw new Error(result.error.message);
	return JSON.parse(result.valueRepr ?? "null");
}

describe("Julia lazy handles (Refs senpi#3048)", () => {
	it.each(["missing", "invalid"])("returns empty globals when the sizing asset is %s", async (asset) => {
		await fixture(async (root) => {
			if (asset === "invalid") await writeFile(join(root, "globals.jl"), "function broken(");
			const frames: string[] = [];
			const globals: unknown[] = [];
			await withKernel(
				root,
				async (kernel) => {
					for (const code of ["42", "43"]) {
						const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 60_000 });
						expect(result.ok).toBe(true);
					}
					expect(globals).toEqual([[], []]);
					expect(frames).not.toContain("init-failed");
				},
				undefined,
				{
					memory: {
						thresholds: { gcWatermarkBytes: 0, noticeBytes: 1, ceilingBytes: 0 },
						readFootprint: () => ({ bytes: 2 }),
					},
					onFrame: (message) => {
						frames.push(message.type);
						if (message.type === "memory-globals-result") globals.push(message.globals);
					},
				},
			);
		});
	});

	it("installs zero handle declarations before the first result", async () => {
		await fixture(async (root) => {
			await withKernel(root, async (kernel) => {
				expect(
					await value(
						kernel,
						'Dict("includes" => SENPI_TEST_INCLUDES[], "declarations" => SENPI_TEST_DECLARATIONS[])',
					),
				).toEqual({ includes: 0, declarations: 0 });
			});
		});
	});

	it.each(["@async", "Threads.@spawn"])("creates the first handle inside %s from an empty cwd", async (taskMacro) => {
		await fixture(async (root) => {
			await withKernel(root, async (kernel) => {
				// #3048: indirect access bypasses pre-eval installation and exercises the task's lazy include.
				expect(
					await value(
						kernel,
						`f = getproperty(Main, Symbol("han" * "dle"))
task = ${taskMacro} f(${record})
view = fetch(task)
Dict("id" => Base.invokelatest(v -> v["id"], view), "includes" => SENPI_TEST_INCLUDES[])`,
					),
				).toEqual({ id: "st_first", includes: 1 });
			});
		});
	});

	it("includes once when two real tasks create their first handles concurrently", async () => {
		await fixture(async (root) => {
			const script = join(root, "concurrent.jl");
			await writeFile(
				script,
				`${counters}
Base.include(Main, ${JSON.stringify(join(root, "prelude.jl"))})
@assert SENPI_TEST_INCLUDES[] == 0
SENPI_TEST_BLOCK_INCLUDE[] = true
attempting = Channel{Nothing}(2)
first_task = @async begin
    put!(attempting, nothing)
    handle(${record})
end
second_task = @async begin
    put!(attempting, nothing)
    handle(Dict("kind" => "agent", "id" => "st_second", "run_epoch" => 0))
end
take!(attempting)
take!(attempting)
take!(SENPI_TEST_ENTERED)
put!(SENPI_TEST_RELEASE, nothing)
put!(SENPI_TEST_RELEASE, nothing)
first_view, second_view = fetch(first_task), fetch(second_task)
@assert SENPI_TEST_INCLUDES[] == 1
@assert Base.invokelatest(getindex, first_view, "id") == "st_first"
@assert Base.invokelatest(getindex, second_view, "id") == "st_second"
@assert Base.invokelatest(getproperty, first_view, :control).ref["id"] == "st_first"
@assert Base.invokelatest(getproperty, second_view, :control).ref["id"] == "st_second"
Base.println("CONCURRENT_HANDLES_OK")
`,
			);
			const result = await execute("julia", ["--startup-file=no", "--compile=min", "--optimize=0", script], {
				cwd: join(root, "cwd"),
				timeout: 60_000,
			});
			expect(result.stdout.trim()).toBe("CONCURRENT_HANDLES_OK");
		});
	});

	it("keeps task waiting lazy before any handle is created", async () => {
		await fixture(async (root) => {
			await withKernel(root, async (kernel) => {
				expect(
					await value(
						kernel,
						'task = @async 42; wait(task); Dict("value" => fetch(task), "includes" => SENPI_TEST_INCLUDES[])',
					),
				).toEqual({ value: 42, includes: 0 });
			});
		});
	});

	it("loads named handle types before annotations and isa checks are evaluated", async () => {
		await fixture(async (root) => {
			await withKernel(root, async (kernel) => {
				expect(
					await value(
						kernel,
						`accept(view::SenpiHandle) = view
view = accept(handle(${record}))
Dict("typed" => view isa SenpiHandle, "control" => view.control isa SenpiHandleControl, "includes" => SENPI_TEST_INCLUDES[])`,
					),
				).toEqual({ typed: true, control: true, includes: 1 });
			});
		});
	});

	it("serializes and displays a first handle inside a user function", async () => {
		await fixture(async (root) => {
			await withKernel(root, async (kernel) => {
				expect(
					await value(
						kernel,
						`function first_view()
    view = handle(${record})
    display(view)
    Dict("id" => view["id"], "control" => sprint(show, view.control), "keys" => sort(collect(keys(view))))
end
first_view()`,
					),
				).toEqual({
					id: "st_first",
					control: "<handle.control agent://st_first@0>",
					keys: ["handle", "id", "kind", "run_epoch"],
				});
			});
		});
	});

	it("restarts with zero declarations and recreates a saved handle reference", async () => {
		await fixture(async (root) => {
			await withKernel(root, async (kernel) => {
				expect(await value(kernel, `handle(${record})["id"]`)).toBe("st_first");
				await kernel.reset();
				expect(await value(kernel, "SENPI_TEST_INCLUDES[]")).toBe(0);
				expect(
					await value(
						kernel,
						`view = handle(${record}); Dict("id" => view["id"], "includes" => SENPI_TEST_INCLUDES[])`,
					),
				).toEqual({ id: "st_first", includes: 1 });
			});
		});
	});

	it("wraps the first completion handle without predeclared types", async () => {
		await fixture(async (root) => {
			const server = await startBridgeServer({
				onCall: async () => {
					throw new Error("no tool call expected");
				},
				onEmit: async () => {},
				onCompletion: async () => ({ kind: "completion", id: "cp_first", run_epoch: 0 }),
			});
			try {
				await withKernel(
					root,
					async (kernel) => {
						expect(
							await value(
								kernel,
								`function complete_first()
    view = completion("hello"; handle=true)
    Dict("id" => view["id"], "ref" => view.control.ref, "includes" => SENPI_TEST_INCLUDES[])
end
complete_first()`,
							),
						).toEqual({ id: "cp_first", ref: { kind: "completion", id: "cp_first", run_epoch: 0 }, includes: 1 });
					},
					{ port: server.port, token: server.token },
				);
			} finally {
				await server.close();
			}
		});
	});
});
