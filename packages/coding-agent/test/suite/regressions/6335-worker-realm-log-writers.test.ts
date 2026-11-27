import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { guardLogPath } from "../../../src/core/extensions/builtin/moved-path-guard/guard-log.ts";

// senpi#6335: the resolved-value registry is per realm. Every runtime resolves a session's references in the realm that
// owns that session's writers (a session worker builds its own model runtime and loads its own extensions), so a worker
// realm must redact, in its own writers, what it resolved. The value is assembled at runtime and has no credential shape.

const root = mkdtempSync(join(tmpdir(), "senpi-6335-"));
const fixture = new URL("./fixtures/6335-worker-resolve-and-log.ts", import.meta.url);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(guardLogPath(), { force: true });
});

describe("a worker realm's writers redact what that realm resolved (senpi#6335)", () => {
	it("redacts an $env value resolved inside a worker in session, config-reload, compaction and guard logs", async () => {
		const value = ["worker", "only", "4".repeat(6), "resolved"].join("~");
		const agentDir = join(root, "worker");
		const worker = new Worker(fixture, {
			workerData: { agentDir, name: "SENPI_6335_SYNTHETIC", value },
			execArgv: [],
		});
		const [message] = await once(worker, "message", { signal: AbortSignal.timeout(25_000) });
		await worker.terminate();
		expect(message).toBe("logged");

		const files = [
			join(agentDir, "logs", "session.log"),
			join(agentDir, "logs", "config-reload.log"),
			join(agentDir, "logs", "compaction.log"),
			guardLogPath(),
		];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			expect(text).toContain("provider rejected key [redacted]");
			expect(text).not.toContain(value);
		}
	});
});
