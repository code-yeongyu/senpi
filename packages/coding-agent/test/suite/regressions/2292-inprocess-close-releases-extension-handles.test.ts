import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * senpi#2292: on the in-process runtime, closing a session must release what that
 * session's extension code left running (a loopback listener keeping a buffer
 * reachable), even when the extension never tears it down on `session_shutdown`.
 *
 * Runs `close-session-footprint.mjs` on BUN in its own process: the fixture uses
 * `Bun.serve`, and only Bun can force the full GC that separates "retained" from
 * "not yet swept" (the vitest runtime is Node).
 */
const sampleSchema = z.object({
	sessions: z.number(),
	footprintMb: z.number(),
	rssMb: z.number(),
	heapMb: z.number(),
	listeners: z.number(),
});
const reportSchema = z.object({ samples: z.array(sampleSchema).min(2), sessionsLeft: z.number(), errors: z.number() });

const SESSIONS = 6;
const ALLOC_MB = 8;

async function runFootprintCell(extension: "leaky" | "teardown") {
	const packageRoot = resolve(import.meta.dirname, "..", "..", "..");
	const script = resolve(packageRoot, "scripts", "qa-rpc-socket", "close-session-footprint.mjs");
	const args = [script, "--extension", extension, "--sessions", String(SESSIONS), "--every", String(SESSIONS)];
	const { stdout } = await promisify(execFile)("bun", [...args, "--mb", String(ALLOC_MB)], {
		cwd: packageRoot,
		maxBuffer: 8 * 1024 * 1024,
	});
	const reported = stdout.trim().split("\n").at(-1);
	if (!reported) throw new Error("close-session-footprint.mjs produced no report line");
	return reportSchema.parse(JSON.parse(reported));
}

describe("senpi#2292 in-process close_session releases extension-owned handles", () => {
	it("leaves no listener and no retained buffer behind an extension without teardown", async () => {
		const report = await runFootprintCell("leaky");
		const first = report.samples[0];
		const last = report.samples.at(-1);
		if (!first || !last) throw new Error("missing samples");
		expect(report.errors).toBe(0);
		expect(report.sessionsLeft).toBe(0);
		expect(last.listeners).toBe(0);
		// Retaining every buffer would add SESSIONS * ALLOC_MB of heap; allow well under half of that.
		expect(last.heapMb - first.heapMb).toBeLessThan((SESSIONS * ALLOC_MB) / 2);
	}, 120_000);

	it("still lets an extension that tears down on session_shutdown do so without errors", async () => {
		const report = await runFootprintCell("teardown");
		const last = report.samples.at(-1);
		expect(report.errors).toBe(0);
		expect(last?.listeners).toBe(0);
	}, 120_000);
});
