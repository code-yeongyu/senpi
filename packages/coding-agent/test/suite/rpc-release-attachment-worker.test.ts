import { afterEach, expect, it, vi } from "vitest";
import { retainHost } from "./rpc-retain-on-disconnect-support.ts";

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	const { EventEmitter } = await import("node:events");
	return {
		...actual,
		Worker: class extends EventEmitter {
			postMessage(): void {}
			terminate(): Promise<number> {
				return Promise.resolve(0);
			}
		},
	};
});
afterEach(() => vi.restoreAllMocks());

// senpi#3795: worker settlement uses the same disconnect path as in-process sessions.
it("defers the last worker release after the original owner drops mid-turn", async () => {
	await using host = await retainHost();
	await host.open("owner", { cwd: host.cwd });
	const [row] = await host.list();
	if (!row?.sessionPath) throw new Error("Missing worker session");
	await host.open("temporary", { cwd: host.cwd, sessionPath: row.sessionPath });
	await host.client(row.sessionId).activity({ busy: true, streaming: true });
	await host.drop("owner");
	const release = await host.writer.withConnection("temporary", () =>
		host.router.handle({
			id: "release",
			type: "release_attachment",
			sessionId: row.sessionId,
		}),
	);
	expect(release).toMatchObject({ success: true, data: { deferred: true } });
	expect(host.posted.filter(({ message }) => message.type === "close")).toEqual([]);
	await host.client(row.sessionId).output({ type: "agent_settled" });
	await host.client(row.sessionId).activity({ busy: false, streaming: false }, true);
	await host.settle();
	expect(await host.list()).toEqual([]);
	expect(host.posted.filter(({ message }) => message.type === "close")).toHaveLength(1);
});
