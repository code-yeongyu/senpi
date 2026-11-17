import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeStartupHandOff, STARTUP_EVENT_FD } from "../../../src/modes/rpc/host-startup-wire.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";

const child = join(import.meta.dirname, "..", "..", "fixtures", "startup-filler-lost-child.ts");
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const listedFillers = Array.from({ length: STARTUP_EVENT_FD - 4 }, (_, index) => index + 4);

function lostFillerHandOff(): string {
	return encodeStartupHandOff({
		binding: {
			attempt: "6".repeat(32),
			endpoint: "/fixture.sock",
			instanceId: "fixture",
			generation: 0,
			launchKind: "initial",
			predecessor: null,
		},
		role: "host",
		budgetMs: 180_000,
		fillers: listedFillers,
	});
}

// The compiled launcher re-execs itself after Bun marked every inherited descriptor from 4 up close-on-exec, so the
// host's first entry holds a filler list for slots it no longer has, and Bun's own copies of stdout and stderr sit at
// those numbers. This child gets exactly that: the list, and no fillers.
describe.skipIf(process.platform === "win32" || !bunAvailable)(
	"senpi#6282: startup fillers lost before the entry",
	() => {
		it("keeps the runtime's own descriptors, so the first stderr write still lands", () => {
			const dir = mkdtempSync(join(tmpdir(), "senpi-6282-"));
			const stderrPath = join(dir, "stderr.log");
			const stderr = openSync(stderrPath, "a");
			try {
				const run = spawnSync("bun", [child], {
					encoding: "utf8",
					env: { ...hostSpawnEnv(), SENPI_RPC_HOST_STARTUP_EVENTS: lostFillerHandOff() },
					stdio: ["ignore", "pipe", stderr],
					timeout: 60_000,
				});
				const written = readFileSync(stderrPath, "utf8");
				expect(written, written).not.toContain("EBADF");
				expect(run.status, written).toBe(0);
				expect(written).toContain("stderr-ok");
				const control = spawnSync("bun", [child], {
					encoding: "utf8",
					env: hostSpawnEnv(),
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 60_000,
				});
				expect(control.status).toBe(0);
				expect(JSON.parse(run.stdout.trim()).held).toEqual(JSON.parse(control.stdout.trim()).held);
			} finally {
				closeSync(stderr);
				rmSync(dir, { recursive: true, force: true });
			}
		}, 60_000);
	},
);
