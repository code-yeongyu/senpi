import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

// PR #1473: exercise the real sharedHost worker registry, not a reservation mock.
it.each(["unterminated", "legacy", "empty", "missing"])(
	"lets another client open and attach a cancelled %s resume target",
	async (kind) => {
		const host = await startWorkerHost(
			`export default function(pi) {
				pi.on("session_before_switch", () => ({ cancel: true }));
			}`,
			{ socket: true },
		);
		try {
			const target = join(host.scratch, "cancelled.jsonl");
			const bytes =
				kind === "empty"
					? ""
					: JSON.stringify({
							type: "session",
							version: kind === "legacy" ? 1 : 3,
							id: "cancelled",
							timestamp: new Date(0).toISOString(),
							cwd: host.cwd,
						});
			if (kind !== "missing") await writeFile(target, bytes);
			const a = await host.connect();
			const b = await host.connect();
			const c = await host.connect();
			const opened = await a.request({ type: "open_session", cwd: host.cwd });
			expect(opened.success).toBe(true);
			for (let attempt = 0; attempt < 3; attempt++) {
				const cancelled = await a.request({
					type: "switch_session",
					sessionId: opened.data?.sessionId,
					sessionPath: target,
				});
				expect(cancelled).toMatchObject({ success: true, data: { cancelled: true } });
				if (kind === "missing") await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
				else expect(await readFile(target, "utf8")).toBe(bytes);
			}
			const selfCancelled = await a.request({
				type: "switch_session",
				sessionId: opened.data?.sessionId,
				sessionPath: opened.data?.state?.sessionFile,
			});
			expect(selfCancelled).toMatchObject({ success: true, data: { cancelled: true } });
			const selfAttached = await c.request({
				type: "open_session",
				cwd: host.cwd,
				sessionPath: opened.data?.state?.sessionFile,
			});
			expect(selfAttached).toMatchObject({
				success: true,
				data: { attached: true, sessionId: opened.data?.sessionId },
			});
			const other = await b.request({ type: "open_session", cwd: host.cwd, sessionPath: target });
			expect(other).toMatchObject({ success: true });
			expect(other.data?.sessionId).not.toBe(opened.data?.sessionId);
			const attached = await c.request({ type: "open_session", cwd: host.cwd, sessionPath: target });
			expect(attached).toMatchObject({ success: true, data: { attached: true, sessionId: other.data?.sessionId } });
			const live = await a.request({ type: "get_state", sessionId: opened.data?.sessionId });
			expect(live).toMatchObject({ success: true, data: { sessionId: opened.data?.state?.sessionId } });
		} finally {
			await host.dispose();
		}
	},
	60_000,
);

// A factory mutates the target only to deterministically exercise the real acceptance failure path.
it.each(["owned", "changed"])(
	"rejects an %s acceptance after veto without destructive shutdown",
	async (failure) => {
		const host = await startWorkerHost(`
		import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
		export default function(pi) {
			if (existsSync("mutate-next")) {
				unlinkSync("mutate-next");
				appendFileSync("target.jsonl", "\\n");
			}
			pi.on("session_before_switch", () => { writeFileSync("switch-fired", "1"); });
			pi.on("session_shutdown", () => { writeFileSync("shutdown-fired", "1"); });
		}
	`);
		try {
			const target = join(host.cwd, "target.jsonl");
			const bytes = JSON.stringify({
				type: "session",
				version: 3,
				id: "destination",
				timestamp: new Date(0).toISOString(),
				cwd: host.cwd,
			});
			await writeFile(target, bytes);
			const live = await host.request({ type: "open_session", cwd: host.cwd });
			expect(live.success).toBe(true);
			if (failure === "owned") {
				expect(await host.request({ type: "open_session", cwd: host.cwd, sessionPath: target })).toMatchObject({
					success: true,
				});
			} else {
				await writeFile(join(host.cwd, "mutate-next"), "1");
			}
			const before = await readFile(target);
			const rejected = await host.request({
				type: "switch_session",
				sessionId: live.data?.sessionId,
				sessionPath: target,
			});
			expect(rejected).toMatchObject({ success: false });
			if (failure === "owned") {
				expect(rejected.error).toContain("session_path_in_use");
				expect(await readFile(target)).toEqual(before);
			} else {
				expect(rejected.error).toContain("Session file changed while preparing resume");
				// Revalidation failed after acquiring a new grant. It must be released without worker exit.
				expect(await host.request({ type: "open_session", cwd: host.cwd, sessionPath: target })).toMatchObject({
					success: true,
				});
			}
			expect(await readFile(join(host.cwd, "switch-fired"), "utf8")).toBe("1");
			await expect(readFile(join(host.cwd, "shutdown-fired"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await host.request({ type: "get_state", sessionId: live.data?.sessionId })).toMatchObject({
				success: true,
				data: { sessionId: live.data?.state?.sessionId },
			});
		} finally {
			await host.dispose();
		}
	},
	60_000,
);
