import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { decodeBridgeFrame } from "../../src/bridge/protocol.ts";
import { JuliaKernel } from "../../src/kernels/jl/kernel.ts";
import { RubyKernel } from "../../src/kernels/rb/kernel.ts";
import type { SubprocessSpawn } from "../../src/kernels/shared/subprocess-process.ts";

const MIB = 1024 * 1024;

/** Counts actual runner walks and wire payloads, without adding a production counter. */
export async function memoryGlobalsHarness(language: "jl" | "rb", liveBytes: number) {
	const root = await mkdtemp(join(tmpdir(), "senpi-memory-globals-"));
	const extension = language === "jl" ? "jl" : "rb";
	const sourceRoot = join(import.meta.dirname, "../../src/kernels", language);
	const runner = await readFile(join(sourceRoot, `runner.${extension}`), "utf8");
	const entry =
		language === "jl" ? "function senpi_largest_globals(limit::Int)" : "def __senpi_largest_globals(limit)";
	const counter =
		language === "jl"
			? '\n    senpi_emit(Dict("type" => "status", "event" => Dict("op" => "globals-walk")))'
			: '\n  __senpi_emit({ "type" => "status", "event" => { "op" => "globals-walk" } })';
	let instrumented = runner.includes(entry);
	await writeFile(join(root, `runner.${extension}`), runner.replace(entry, entry + counter));
	for (const asset of await readdir(sourceRoot)) {
		if (asset.endsWith(`.${extension}`) && asset !== `runner.${extension}`) {
			const content = await readFile(join(sourceRoot, asset), "utf8");
			instrumented ||= content.includes(entry);
			await writeFile(join(root, asset), content.replace(entry, entry + counter));
		}
	}
	if (!instrumented) throw new Error("missing globals instrumentation seam");
	const counts = { walks: 0, payloads: 0, footprints: 0 };
	const exits: Promise<void>[] = [];
	const spawnRunner: SubprocessSpawn = (command, args, options) => {
		const last = args.at(-1);
		if (last === undefined) throw new Error("missing runner asset");
		const child = spawn(command, [...args.slice(0, -1), join(root, `runner.${extension}`)], {
			...options,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		exits.push(exited);
		const frames = createInterface({ input: child.stdout });
		frames.on("line", (line) => {
			const decoded = decodeBridgeFrame(line);
			if (!decoded.ok) throw new Error(decoded.error.message);
			const message = decoded.message;
			if (message.type === "status" && message.event.op === "globals-walk") counts.walks++;
			if (message.type === "result" && message.memory !== undefined) counts.payloads++;
		});
		child.once("exit", () => frames.close());
		// These fixtures own no descendants. Teardown uses EOF, never process-group signals.
		child.kill = () => {
			child.stdin.end();
			return true;
		};
		return {
			stdin: child.stdin,
			stdout: child.stdout,
			stderr: child.stderr,
			on: child.on.bind(child),
			once: child.once.bind(child),
			removeListener: child.removeListener.bind(child),
			kill: child.kill,
			// Retain the real PID for footprint accounting, but group delivery is rejected by the QA guard.
			pid: child.pid,
		};
	};
	const options = {
		cwd: dirname(root),
		sessionId: `${language}-memory-globals`,
		connection: { port: 1, token: "unused" },
		spawn: spawnRunner,
		memory: {
			thresholds: {
				gcWatermarkBytes: 32 * MIB,
				noticeBytes: 64 * MIB,
				ceilingBytes: 512 * MIB,
			},
			readFootprint: () => {
				counts.footprints++;
				return { bytes: liveBytes };
			},
		},
	};
	const kernel = language === "jl" ? JuliaKernel.start(options) : RubyKernel.start(options);
	return {
		kernel,
		counts,
		async close() {
			await kernel.close();
			await Promise.all(exits);
			await rm(root, { recursive: true, force: true });
		},
	};
}
