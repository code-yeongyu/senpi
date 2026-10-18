import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { decodeBridgeFrame } from "../../../src/bridge/protocol.ts";
import { resolveCommandPath } from "../../../src/interpreters/resolve-command.ts";
import { JuliaKernel } from "../../../src/kernels/jl/kernel.ts";

const julia = resolveCommandPath("julia");
// Julia records a specialization for every argument type an interpreted call dispatches on,
// so an empty list proves the generic frame encoder never ran before this cell.
const encoderSpecializations =
	"[string(mi.specTypes) for f in (senpi_json, senpi_escape) for m in methods(f) for mi in Base.specializations(m)]";

function encoderTypes(result: Awaited<ReturnType<JuliaKernel["run"]>>): unknown {
	if (!result.ok) throw new Error(result.error.message);
	return JSON.parse(result.valueRepr ?? "null");
}

describe("Julia startup frames (Refs senpi#3048)", () => {
	it.skipIf(julia === undefined)(
		"reports every startup stage without running the frame encoder in the first or the replacement interpreter",
		async () => {
			// Given: a real kernel whose startup stages are observed on each interpreter's stdout.
			const stages: string[] = [];
			const kernel = JuliaKernel.start({
				command: julia,
				cwd: process.cwd(),
				sessionId: "jl-startup-frames",
				connection: { port: 1, token: "unused" },
				spawn: (command, args, options) => {
					const child = spawn(command, [...args], { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
					const frames = createInterface({ input: child.stdout });
					frames.on("line", (line) => {
						const decoded = decodeBridgeFrame(line);
						if (!decoded.ok) return;
						const message = decoded.message;
						if (message.type === "status" && message.event.op === "kernel-startup") {
							stages.push(String(message.event.stage));
						}
					});
					child.once("exit", () => frames.close());
					return child;
				},
			});
			try {
				// When: the first cell inspects the encoder before any result was encoded.
				const first = await kernel.run({ cellId: "first", code: encoderSpecializations, timeoutMs: 60_000 });
				// Then: startup frames reached the host without encoder work.
				expect(encoderTypes(first)).toEqual([]);

				// Given: an active cell owns the interpreter and a probe cell waits behind it.
				const ready = Promise.withResolvers<void>();
				let output = "";
				const active = kernel.run({
					cellId: "active",
					code: 'println("INTERRUPT_READY"); flush(stdout); while true; yield(); end',
					timeoutMs: 60_000,
					onMessage: (message) => {
						if (message.type !== "text") return;
						output += message.data;
						if (output.includes("INTERRUPT_READY")) ready.resolve();
					},
				});
				await Promise.race([
					ready.promise,
					active.then(() => {
						throw new Error("active cell ended before its readiness signal");
					}),
				]);
				const replacementProbe = kernel.run({
					cellId: "replacement",
					code: encoderSpecializations,
					timeoutMs: 60_000,
				});

				// When: interruption replaces the interpreter.
				const handle = await kernel.interrupt("startup frames interrupt", "active");

				// Then: the replacement also starts without encoder work and reports all stages.
				await expect(handle.stateRetained).resolves.toBe(false);
				await expect(active).resolves.toMatchObject({ ok: false, cellId: "active" });
				expect(encoderTypes(await replacementProbe)).toEqual([]);
				const perInterpreter = ["stdlib-imports", "runtime-init", "host-init"];
				expect(stages).toEqual([...perInterpreter, ...perInterpreter]);
			} finally {
				await kernel.close();
			}
		},
		150_000,
	);
});
