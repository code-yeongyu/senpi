// senpi#5635: eval kernels and every child they start inherit the host's environment WITHOUT the RPC host's
// supervisor hand-off, and carry the origin attribution instead. The host's own process.env keeps the hand-off.
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { childEnvironmentOf } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConnectionConfig } from "../src/bridge/protocol.ts";
import type { JavaScriptKernelMode } from "../src/kernels/js/context-manager.ts";
import { spawnProcessWorker } from "../src/kernels/js/process-worker.ts";
import { type KernelSpawnOptions, PythonKernel } from "../src/kernels/py/kernel.ts";
import { inheritedEnvironmentDelta } from "../src/kernels/session-env.ts";
import { parseJavaScriptResult, runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";
import { FakeChild } from "./py-kernel/fixtures.ts";

const HANDOFF = ["SENPI_RPC_HOST_DAEMON_DIR", "SENPI_RPC_HOST_INSTANCE_ID", "SENPI_RPC_INTERNAL_KEY_STDIN"] as const;
const ORIGIN = "SENPI_RPC_ORIGIN_HOST_INSTANCE";
const inheritedEnv = () => childEnvironmentOf(process.env);

function stubHost(): void {
	vi.stubEnv("SENPI_RPC_HOST_DAEMON_DIR", "/synthetic/daemon");
	vi.stubEnv("SENPI_RPC_HOST_INSTANCE_ID", "synthetic-host");
	vi.stubEnv("SENPI_RPC_INTERNAL_KEY_STDIN", "1");
	vi.stubEnv("ISSUE_5635_KEEP", "keep");
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("issue #5635 kernel environments never carry the host's supervisor hand-off", () => {
	it("the worker-thread delta names exactly the dropped names and the origin it sets", () => {
		// Given: a host env holding its hand-off.
		const base = { PATH: "/bin", SENPI_RPC_HOST_INSTANCE_ID: "g1", SENPI_RPC_HOST_DAEMON_DIR: "/d" };

		// When: the delta to its child env is taken.
		const delta = inheritedEnvironmentDelta(base, childEnvironmentOf(base, "linux"));

		// Then: only hand-off names are removed, and only the origin is set.
		expect(delta).toEqual({
			removedEnv: ["SENPI_RPC_HOST_INSTANCE_ID", "SENPI_RPC_HOST_DAEMON_DIR"],
			inheritedSet: { [ORIGIN]: "g1" },
		});
	});

	it("the Python interpreter spawns without the hand-off and with the origin and session values", async () => {
		// Given: a host env holding its hand-off.
		stubHost();
		const spawns: KernelSpawnOptions[] = [];
		const connection: BridgeConnectionConfig = { port: 1, token: "t" };

		// When: a Python kernel starts with the extension's inherited env.
		const kernel = await PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "handoff-py",
			cwd: process.cwd(),
			connection,
			sessionEnv: { PI_SESSION_ID: "py-5635" },
			inheritedEnv,
			spawnProcess: (options) => {
				spawns.push(options);
				return new FakeChild();
			},
		});
		await kernel.close();

		// Then: the interpreter env drops every hand-off name and keeps the rest.
		const env = spawns[0]?.env ?? {};
		expect(HANDOFF.filter((name) => name in env)).toEqual([]);
		expect(env[ORIGIN]).toBe("synthetic-host");
		expect(env.ISSUE_5635_KEEP).toBe("keep");
		expect(env.PI_SESSION_ID).toBe("py-5635");
		expect(process.env.SENPI_RPC_HOST_INSTANCE_ID).toBe("synthetic-host");
	});

	it("the process-isolated JS kernel child spawns without the hand-off", () => {
		// Given: a host env holding its hand-off.
		stubHost();
		const envs: (NodeJS.ProcessEnv | undefined)[] = [];

		// When: the process kernel child is spawned.
		spawnProcessWorker(new URL("file:///kernel/process-entry.js"), {
			cwd: process.cwd(),
			parallelPoolWidth: 1,
			execPath: process.execPath,
			inheritedEnv,
			spawn: (_command, _args, options) => {
				envs.push(options.env);
				const child = Object.assign(new EventEmitter(), {
					stdin: { write: () => true },
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					kill: () => true,
				});
				return child;
			},
		});

		// Then: the child env has no hand-off name and carries the origin.
		const env = envs[0] ?? {};
		expect(HANDOFF.filter((name) => name in env)).toEqual([]);
		expect(env[ORIGIN]).toBe("synthetic-host");
		expect(env.ISSUE_5635_KEEP).toBe("keep");
	});

	// "inline" is the fallback entry used when the worker entry cannot load; it is a worker thread too (senpi#5653).
	it.each([
		{ expectedMode: "worker", workerEntryUrl: undefined },
		{ expectedMode: "inline", workerEntryUrl: pathToFileURL(join(process.cwd(), "missing-handoff-worker.js")) },
	] satisfies readonly { readonly expectedMode: JavaScriptKernelMode; readonly workerEntryUrl: URL | undefined }[])(
		"a $expectedMode JS kernel's cells and their children see no hand-off while the host keeps it",
		async ({ expectedMode, workerEntryUrl }) => {
			// Given: a host env holding its hand-off.
			stubHost();

			// When: a cell reads its env and a child process reads its own.
			const seen = await withJavaScriptKernel(
				async (kernel) => {
					const run = await runJavaScriptCell(
						kernel,
						[
							"const cp = process.getBuiltinModule('node:child_process');",
							`const names = ${JSON.stringify([...HANDOFF, ORIGIN, "ISSUE_5635_KEEP"])};`,
							"const child = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(' + JSON.stringify(names) + '.map((n) => process.env[n] ?? null)))'], { encoding: 'utf8' });",
							"return { cell: names.map((n) => process.env[n] ?? null), child: JSON.parse(child) };",
						].join("\n"),
					);
					return { mode: kernel.mode, value: parseJavaScriptResult(run.result) };
				},
				{
					sessionEnv: { PI_SESSION_ID: "js-5635" },
					inheritedEnv,
					...(workerEntryUrl === undefined ? {} : { workerEntryUrl }),
				},
			);

			// Then: neither the cell nor its child holds a hand-off name; the host still does.
			const expected = [null, null, null, "synthetic-host", "keep"];
			expect(seen.mode).toBe(expectedMode);
			expect(seen.value).toEqual({ cell: expected, child: expected });
			expect(HANDOFF.filter((name) => process.env[name] === undefined)).toEqual([]);
		},
	);
});
