import { expect, it } from "vitest";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// #3198 review, L5: the F13 surface dedupe must hold on the worker-isolate runtime too - a
// connection attached to several worker sessions hears one loaded_surfaces_changed per
// inventory change, not one per session. The isolate emits to the connection that drove the
// change inline and reports the digest; the host dedupes every other attachment.
it("worker-isolate sessions share the one-per-connection loaded_surfaces_changed dedupe", async () => {
	const host = await startWorkerHost(
		`export default function (pi) {
			pi.on("session_start", (_event, ctx) => {
				globalThis.__rpcTestApis = globalThis.__rpcTestApis ?? new Map();
				globalThis.__rpcTestApis.set(ctx.sessionManager.getSessionId(), pi);
			});
			pi.registerCommand("bump-surface", { description: "test surface bump", handler: async (_args, ctx) => {
				globalThis.__rpcTestApis.get(ctx.sessionManager.getSessionId())?.events.emit("senpi.rpc.mcp_inventory.changed", {
					sessionId: ctx.sessionManager.getSessionId(),
					snapshot: { servers: [{ name: "probe", serverInfo: null, tools: [], resources: [], resourceTemplates: [], authStatus: "unsupported" }] },
				});
			} });
		}`,
		{ socket: true },
	);
	try {
		const a = await host.connect();
		const first = await a.request({ type: "open_session", cwd: host.cwd });
		expect(first.success).toBe(true);
		const second = await a.request({ type: "open_session", cwd: host.cwd });
		expect(second.success).toBe(true);
		const s1 = first.data?.sessionId;
		const s2 = second.data?.sessionId;
		expect(typeof s1).toBe("string");
		expect(typeof s2).toBe("string");

		const before = a.records.length;
		// Subscribe to the event before triggering either change, so the count is decided by what
		// arrives, never by a settle window.
		const change = a.wait((record) => record.type === "loaded_surfaces_changed", 30_000);
		const r1 = await a.request({ type: "prompt", sessionId: s1, message: "/bump-surface" });
		const r2 = await a.request({ type: "prompt", sessionId: s2, message: "/bump-surface" });
		expect(r1.success, JSON.stringify(r1)).toBe(true);
		expect(r2.success, JSON.stringify(r2)).toBe(true);
		await change;
		// The dedupe allows exactly one record for a shared transition; assert none of the later
		// records that did arrive is a second surface change.
		const changes = a.records.slice(before).filter((record) => record.type === "loaded_surfaces_changed");
		expect(changes).toHaveLength(1);
	} finally {
		await host.dispose();
	}
}, 120_000);
