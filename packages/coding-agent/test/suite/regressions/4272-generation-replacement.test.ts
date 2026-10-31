import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// #4272 RULING-99 gap 1b: real host replacement, persisted turns, engine cuts and reopen.
it.each(["new_session", "switch_session", "fork"] as const)(
	"%s carries the lane and target floors into the replacement and its reopen",
	async (kind) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		await using host = await statusHost();
		const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
		const client = host.client("owner");
		host.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("persisted answer")));
		const open = async (sessionPath?: string) =>
			String(
				dataOf(
					await client.request({
						type: "open_session",
						cwd: host.cwd,
						sessionPath,
						provider: host.model.provider,
						modelId: host.model.id,
						permissionPreset: "full-access",
					}),
				).sessionId,
			);
		const prompt = async (sessionId: string) => {
			const offset = client.inbox.length;
			const settled = client.waitFor(
				(record) =>
					client.inbox.indexOf(record) >= offset && record.type === "agent_idle" && record.sessionId === sessionId,
			);
			dataOf(await client.request({ type: "prompt", sessionId, message: "persist this turn" }));
			await settled;
		};
		const freeze = (sessionId: string) => {
			const entry: RpcSessionEntry | undefined = admissions.mock.results.findLast(
				(result) => result.type === "return",
			)?.value;
			if (!entry?.acceptance) throw new Error("missing real acceptance lane");
			const result = host.writer.recoveryCheckpoints.freeze(
				{
					socketEpoch: "test",
					admissionId: "a",
					routeKind: "ordinary",
					peer: "owner",
					sessionId,
				},
				entry.acceptance,
			);
			if (!result.ok) throw new Error(JSON.stringify(result.failure));
			const generation = result.value.token.admission.generation;
			host.writer.recoveryCheckpoints.release(result.value.token);
			return generation;
		};
		const cut = async (sessionId: string) => {
			dataOf(await client.request({ type: "get_state", sessionId }));
			return freeze(sessionId);
		};
		let targetPath: string | undefined;
		let targetFloor = 0;
		if (kind === "switch_session") {
			const targetId = await open();
			await prompt(targetId);
			await cut(targetId);
			const state = dataOf(await client.request({ type: "get_state", sessionId: targetId }));
			targetPath = String(state.sessionFile);
			dataOf(await client.request({ type: "close_session", sessionId: targetId }));
			// Burn another reservation so the target floor exceeds even A's reserved ceiling.
			const resumed = await open(targetPath);
			await cut(resumed);
			dataOf(await client.request({ type: "close_session", sessionId: resumed }));
			const counter = join(
				host.agentDir,
				`.senpi-recovery-generations-${process.getuid?.() ?? "user"}`,
				createHash("sha256").update(String(state.sessionId)).digest("hex"),
			);
			targetFloor = Number(await readFile(counter, "utf8"));
		}
		const sessionId = await open();
		await prompt(sessionId);
		const before = await cut(sessionId);
		if (kind === "switch_session") expect(targetFloor).toBeGreaterThan(before);
		const fields: Record<string, unknown> = { type: kind, sessionId };
		if (kind === "switch_session") fields.sessionPath = targetPath;
		if (kind === "fork") {
			const { messages } = dataOf(await client.request({ type: "get_fork_messages", sessionId }));
			if (!Array.isArray(messages) || !messages[0]?.entryId) throw new Error("missing persisted fork entry");
			fields.entryId = messages[0].entryId;
		}
		let published: number | undefined;
		const enqueue = host.writer.enqueue.bind(host.writer);
		vi.spyOn(host.writer, "enqueue").mockImplementation((id, record) => {
			if (id === sessionId && "type" in record && record.type === "session_replaced") published = freeze(id);
			return enqueue(id, record);
		});
		dataOf(await client.request(fields));
		expect
			.soft(Number(published), "the synchronous first cut at replacement publication")
			.toBeGreaterThan(Math.max(before, targetFloor));
		const replaced = await cut(sessionId);
		expect.soft(replaced).toBeGreaterThan(Number(published));
		await prompt(sessionId);
		const replacement = dataOf(await client.request({ type: "get_state", sessionId }));
		dataOf(await client.request({ type: "close_session", sessionId }));
		const reopened = await open(String(replacement.sessionFile));
		const state = dataOf(await client.request({ type: "get_state", sessionId: reopened }));
		expect(state.sessionId).toBe(replacement.sessionId);
		expect(await cut(reopened)).toBeGreaterThan(replaced);
	},
	120_000,
);
