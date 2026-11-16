import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHostCore } from "../../../src/modes/rpc/multi-session-host.ts";
import { hostInstanceId } from "../../../src/modes/rpc/protocol-identity.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { inProcessRuntimeFactory } from "../rpc-inprocess-host-support.ts";
import * as sessionFolder from "../../../src/modes/rpc/open-session-folder.ts";

vi.mock("../../../src/modes/rpc/open-session-folder.ts", { spy: true });

// senpi#6819: work accepted before a registry row exists, and requests independent of a streaming turn.
it.each(["opening", "request", "reopen"] as const)(
	"refuses while %s is in flight without beginning a drain",
	async (work) => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-6819-inflight-"));
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const records: unknown[] = [];
		const writer = new SessionEventWriter((line) => records.push(JSON.parse(line)));
		writer.registerConnection("opener", {
			writeRaw: (line) => records.push(JSON.parse(line)),
			waitForBackpressure: async () => {},
		});
		const factory = inProcessRuntimeFactory();
		let holdOpen = work === "opening";
		const core = createHostCore(
			{
				agentDir: dir,
				cwd: dir,
				createRuntime: async (options) => {
					if (holdOpen) {
						entered.resolve();
						await finish.promise;
					}
					const created = await factory.createRuntime(options);
					Object.assign(created.session, { abortForHostShutdown: () => created.session.abort() });
					return created;
				},
				createBinding: async () => ({
					handle: async () => {
						entered.resolve();
						await finish.promise;
					},
					dispose: async () => {},
				}),
			},
			writer,
		);
		let running: Promise<unknown> | undefined;
		try {
			if (work === "request") {
				await writer.withConnection("opener", () =>
					core.handle(JSON.stringify({ type: "open_session", id: "open", retain_on_disconnect: true })),
				);
				await writer.flush();
				const row = records.find((r) => typeof r === "object" && r !== null && Reflect.get(r, "id") === "open");
				const data: unknown = typeof row === "object" && row !== null ? Reflect.get(row, "data") : undefined;
				const sessionId: unknown =
					typeof data === "object" && data !== null ? Reflect.get(data, "sessionId") : undefined;
				if (typeof sessionId !== "string") throw new Error("open response missing");
				await writer.withConnection("opener", () =>
					core.handle(JSON.stringify({ type: "release_attachment", sessionId, id: "release" })),
				);
				running = core.router.handle({ type: "get_state", sessionId });
			} else if (work === "reopen") {
				vi.mocked(sessionFolder.openSessionFolder).mockImplementationOnce(async () => {
					entered.resolve();
					await finish.promise;
					return dir;
				});
				running = core.router.reopenParked({ sessionPath: join(dir, "reopen.jsonl"), retainOnDisconnect: true });
			} else {
				running = core.handle(JSON.stringify({ type: "open_session", id: "opening" }));
			}
			await entered.promise;
			await core.handle(JSON.stringify({ type: "drain_if_idle", instanceId: hostInstanceId(), id: "drain" }));
			await writer.flush();
			expect(records).toContainEqual(
				expect.objectContaining({
					id: "drain",
					success: true,
					data: { action: "refuse", reason: "host_busy" },
				}),
			);
			finish.resolve();
			await running;
			holdOpen = false;
			await core.handle(JSON.stringify({ type: "open_session", id: "after" }));
			await writer.flush();
			expect(records).toContainEqual(expect.objectContaining({ id: "after", success: true }));
		} finally {
			vi.restoreAllMocks();
			finish.resolve();
			await running;
			await core.router.dispose();
			await core.machineOps.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	},
);
