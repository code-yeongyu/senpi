import { readFileSync } from "node:fs";
import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadNativePty, type NativePtyLoadResult } from "../src/native-loader.ts";
import { TOOL_CHILD_OOM_SCORE_ADJ } from "../src/oom-score.ts";
import { TerminalSession, type TerminalSessionDependencies } from "../src/session.ts";

// Platform contract: on Linux a runaway tool child, not the host that spawned it, is the OOM killer's first victim.
const linux = process.platform === "linux";
const nativeAvailable = linux && loadNativePty().native !== null;
const runningUnderBun = process.versions.bun !== undefined;

const nativeUnavailable: NativePtyLoadResult = {
	native: null,
	diagnostic: {
		code: "native-unavailable",
		runtime: "node",
		host: "test-host",
		attemptedPath: "/missing/senpi_pty.node",
		attemptedPaths: ["/missing/senpi_pty.node"],
		message: "test native unavailable",
	},
};

const backends: ReadonlyArray<readonly [string, boolean, TerminalSessionDependencies]> = [
	["native", nativeAvailable, {}],
	["pipe-fallback", linux, { nativeLoadResult: nativeUnavailable }],
	["bun", linux && runningUnderBun, { env: { SENPI_BUN_TERMINAL: "1" } }],
];

function readOomScoreAdj(pid: number): number {
	return Number(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim());
}

describe("TerminalSession child oom_score_adj", () => {
	for (const [backend, enabled, dependencies] of backends) {
		it.runIf(enabled)(
			`${backend} child starts as the preferred OOM victim while the host keeps its value`,
			async () => {
				const hostValue = readOomScoreAdj(process.pid);
				const session = new TerminalSession(
					{ command: "/bin/sh", args: ["-c", 'echo "READY;"; exec sleep 30'] },
					dependencies,
				);
				let output = "";
				const ready = new Promise<void>((resolve) => {
					const unsubscribe = session.onData((chunk) => {
						output += chunk.toString("utf8");
						if (!output.includes("READY;")) return;
						unsubscribe();
						resolve();
					});
				});
				session.start();
				onTestFinished(async () => {
					session.kill("SIGKILL");
					await session.waitExit();
				});
				await ready;

				expect(session.backend).toBe(backend);
				expect(session.pid).toBeDefined();
				expect(readOomScoreAdj(session.pid ?? 0)).toBe(TOOL_CHILD_OOM_SCORE_ADJ);
				expect(readOomScoreAdj(process.pid)).toBe(hostValue);
			},
			10_000,
		);
	}
});
