import * as fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { statusHost } from "../rpc-session-status-support.ts";

vi.mock("node:fs/promises", { spy: true });
const realFs = await vi.importActual<typeof fs>("node:fs/promises");
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// #4272 T2/X04: an index commit failure must answer through (not behind) its own baseline barrier.
it("T2/X04 snapshot failure resolves the installed response barrier and releases the returned subscription", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const escaped = Promise.withResolvers<void>();
	const enqueue = host.writer.enqueueControl;
	vi.spyOn(host.writer, "enqueueControl").mockImplementation((...args) => {
		if (Reflect.get(args[0], "command") === "subscribe_sessions" && Reflect.get(args[0], "success") === false)
			escaped.resolve();
		return enqueue.apply(host.writer, args);
	});
	const write = realFs.writeFile;
	vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		if (typeof args[1] === "string" && args[1].startsWith('{"state":"complete"'))
			throw Object.assign(new Error("index full"), { code: "ENOSPC" });
		return write(...args);
	});
	const pending = peer.request({ type: "subscribe_sessions", admissionId: "failed-snapshot" });
	void pending.catch(() => {});
	try {
		const result = await Promise.race([
			pending.then((answer) => ({ kind: "answer" as const, answer })),
			escaped.promise.then(() => ({ kind: "behind_barrier" as const })),
		]);
		expect(result.kind).toBe("answer");
		if (result.kind === "answer")
			expect(result.answer).toMatchObject({ success: false, errorData: { reason: "storage_unavailable" } });
		expect(host.writer.status.connectionSize("peer")).toBe(0);
		expect(host.writer.recoveryEvents?.status().open).toBe(0);
	} finally {
		await host.drop("peer");
	}
}, 120_000);
