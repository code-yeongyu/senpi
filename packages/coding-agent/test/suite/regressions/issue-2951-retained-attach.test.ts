import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHostCore } from "../../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { reservationPhase } from "../rpc-worker-reservation-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

it.each(["idle", "admitted"] as const)(
	"keeps a retained %s real-host session after refusing a racing attach",
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), "held-retained-attach-"));
		const file = join(root, "session.jsonl");
		const id = randomUUID();
		await writeFile(
			file,
			`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
		);
		const started = Promise.withResolvers<void>();
		const unblock = Promise.withResolvers<void>();
		const records: unknown[] = [];
		const writer = new SessionEventWriter((line) => records.push(JSON.parse(line)));
		for (const peer of ["original", "racing"])
			writer.registerConnection(peer, {
				writeRaw: (line) => records.push(JSON.parse(line)),
				waitForBackpressure: () => Promise.resolve(),
			});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: root,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					extensionFactories: [
						(pi) => {
							pi.registerCommand("retained-gate", {
								handler: async () => {
									started.resolve();
									await unblock.promise;
									pi.appendEntry("retained-admitted-finished", { complete: true });
								},
							});
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const core = createHostCore({ agentDir: root, cwd: root, createRuntime }, writer, [], { closeGraceMs: 100 });
		const open = RpcSessionRegistry.prototype.openSession;
		let registry: RpcSessionRegistry | undefined;
		let race = false;
		let holder: Awaited<ReturnType<typeof startSessionHolder>> | undefined;
		let prompt: Promise<void> | undefined;
		vi.spyOn(RpcSessionRegistry.prototype, "openSession").mockImplementation(async function (
			this: RpcSessionRegistry,
			...args
		) {
			registry = this;
			const opened = await open.apply(this, args);
			if (race) {
				expect(opened.attached).toBe(true);
				holder = await startSessionHolder(file, id, root);
			}
			return opened;
		});
		try {
			await writer.withConnection("original", () =>
				core.handle(
					JSON.stringify({
						type: "open_session",
						id: "original",
						cwd: root,
						sessionPath: file,
						retain_on_disconnect: true,
					}),
				),
			);
			if (!registry) throw new Error("Real registry did not open");
			const sessionId = registry.list()[0]?.sessionId;
			if (!sessionId) throw new Error("Real session did not open");
			if (kind === "admitted") {
				prompt = writer.withConnection("original", () =>
					core.handle(JSON.stringify({ type: "prompt", sessionId, message: "/retained-gate" })),
				);
				await reservationPhase("retained-command-started", started.promise);
			}
			writer.unregisterConnection("original");
			await core.router.releaseConnection("original");
			expect(registry.list()).toMatchObject([{ sessionId, status: "open", attachments: 0 }]);
			race = true;
			await writer.withConnection("racing", () =>
				core.handle(JSON.stringify({ type: "open_session", id: "racing", cwd: root, sessionPath: file })),
			);
			await writer.flush();
			expect(records).toContainEqual(
				expect.objectContaining({ type: "response", id: "racing", success: false, error: "session_held" }),
			);
			expect(registry.list()).toMatchObject([{ sessionId, status: "open", attachments: 0 }]);
			unblock.resolve();
			if (prompt) {
				await reservationPhase("retained-command-finished", prompt);
				expect(SessionManager.open(file).getEntries()).toContainEqual(
					expect.objectContaining({ type: "custom", customType: "retained-admitted-finished" }),
				);
			}
		} finally {
			unblock.resolve();
			await Promise.allSettled(prompt ? [prompt] : []);
			await holder?.stop();
			await core.router.dispose();
			vi.restoreAllMocks();
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
