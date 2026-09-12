import { describe, expect, it } from "vitest";
import type { BridgeConnectionConfig } from "../src/bridge/protocol.ts";
import { type KernelSpawnOptions, PythonKernel } from "../src/kernels/py/kernel.ts";
import { FakeChild, hasPython3, liveKernel, runCell } from "./py-kernel/fixtures.ts";

const childProbe = [
	"import sys, subprocess",
	"int(subprocess.check_output([",
	"\tsys.executable,",
	"\t'-c',",
	"\t\"import os; print(os.environ.get('PI_SESSION_ID', ''), end='')\",",
	"]) == b'py-live-session-77')",
].join("\n");

describe("PythonKernel session environment", () => {
	it("spawns the interpreter with the session environment and without inherited PI_* values", async () => {
		const child = new FakeChild();
		const spawns: KernelSpawnOptions[] = [];
		const connection: BridgeConnectionConfig = { port: 1, token: "t" };
		const previousFile = process.env.PI_SESSION_FILE;
		process.env.PI_SESSION_FILE = "stale-session-file.jsonl";
		try {
			const kernel = await PythonKernel.start({
				interpreterPath: "python3",
				sessionId: "mock-session",
				cwd: process.cwd(),
				connection,
				sessionEnv: { PI_SESSION_ID: "py-session-env-77" },
				spawnProcess: (options) => {
					spawns.push(options);
					return child;
				},
			});
			await kernel.close();
		} finally {
			if (previousFile === undefined) delete process.env.PI_SESSION_FILE;
			else process.env.PI_SESSION_FILE = previousFile;
		}

		expect(spawns).toHaveLength(1);
		const env = spawns[0]?.env;
		expect(env?.PI_SESSION_ID).toBe("py-session-env-77");
		expect(env).not.toHaveProperty("PI_SESSION_FILE");
		expect(env?.PYTHONUNBUFFERED).toBe("1");
	});

	it("keeps the session environment on every interpreter respawn", async () => {
		const children = [new FakeChild(), new FakeChild()];
		const spawns: KernelSpawnOptions[] = [];
		const kernel = await PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "respawn-session",
			cwd: process.cwd(),
			connection: { port: 1, token: "t" },
			sessionEnv: { PI_SESSION_ID: "py-respawn-session" },
			spawnProcess: (options) => {
				spawns.push(options);
				const child = children[spawns.length - 1];
				if (!child) throw new Error("unexpected Python respawn");
				return child;
			},
		});
		try {
			await kernel.reset();
		} finally {
			await kernel.close();
		}

		expect(spawns).toHaveLength(2);
		for (const spawn of spawns) expect(spawn.env?.PI_SESSION_ID).toBe("py-respawn-session");
	});
});

describe.skipIf(!(await hasPython3()))("PythonKernel live session environment", () => {
	it("exposes PI_SESSION_ID to os.environ and to child processes", async () => {
		const kernel = await liveKernel({ sessionEnv: { PI_SESSION_ID: "py-live-session-77" } });
		try {
			const inProcess = await runCell(kernel, "import os\nos.environ.get('PI_SESSION_ID') == 'py-live-session-77'");
			expect(inProcess).toMatchObject({ ok: true, valueRepr: "True" });

			const fromChild = await runCell(kernel, childProbe);
			expect(fromChild).toMatchObject({ ok: true, valueRepr: "1" });
		} finally {
			await kernel.close();
		}
	});

	it("follows the active session when a new kernel starts for another session", async () => {
		const first = await liveKernel({ sessionEnv: { PI_SESSION_ID: "py-live-session-a" } });
		try {
			const observed = await runCell(first, "import os\nos.environ.get('PI_SESSION_ID') == 'py-live-session-a'");
			expect(observed).toMatchObject({ ok: true, valueRepr: "True" });
		} finally {
			await first.close();
		}

		const second = await liveKernel({ sessionEnv: { PI_SESSION_ID: "py-live-session-b" } });
		try {
			const observed = await runCell(second, "import os\nos.environ.get('PI_SESSION_ID') == 'py-live-session-b'");
			expect(observed).toMatchObject({ ok: true, valueRepr: "True" });
		} finally {
			await second.close();
		}
	});
});
