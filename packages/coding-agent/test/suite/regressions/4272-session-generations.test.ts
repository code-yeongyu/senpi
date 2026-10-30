import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { materializerReconnect, MemoryMaterializerAdapter } from "../../../../client/src/materializer-test-kit.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fs>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

const PAIR = ["compact_message_updates_v1", "event_resync"];
afterEach(() => {
	vi.mocked(fs.rename).mockReset();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function connect(rig: ReturnType<typeof createInProcessRig>, peer: string) {
	vi.spyOn(rig.registry, "supportsCompact").mockReturnValue(true);
	expect(
		await rig.send(peer, { type: "set_client_info", id: `select-${peer}`, width: 100, capabilities: PAIR }),
	).toMatchObject({
		success: true,
	});
}

// #4272 RULING-99: the real registry/router/writer, with only the model runtime replaced.
it("reconnect issues a higher generation for the same durable session", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const dir = await fs.mkdtemp(join(tmpdir(), "r99-reconnect-"));
	try {
		await using rig = createInProcessRig(dir);
		await connect(rig, "A");
		let first = await rig.send("A", {
			type: "open_session",
			id: "open-A",
			cwd: dir,
			admissionId: "a",
			retain_on_disconnect: true,
		});
		expect(first?.success).toBe(true);
		const sessionId = String(first?.sessionId);
		const durableSessionId = rig.registry.peek(sessionId)?.durableSessionId ?? "";
		const sessionEpoch = rig.registry.peek(sessionId)?.acceptance?.sessionEpoch ?? "";
		for (let index = 0; index < 3; index++)
			first = await rig.send("A", {
				type: "reset_stream",
				id: `reset-${index}`,
				sessionId,
				admissionId: "a",
			});
		expect(first?.success).toBe(true);
		let connection = 0;
		await materializerReconnect(new MemoryMaterializerAdapter<string>(), async () => {
			if (connection++ === 0) return { sessionId, sessionEpoch, generation: Number(first?.generation) };
			await rig.drop("A");
			await connect(rig, "B");
			const second = await rig.send("B", {
				type: "attach_session",
				id: "open-B",
				sessionId,
				durableSessionId,
				admissionId: "b",
			});
			expect(second?.success).toBe(true);
			return { sessionId, sessionEpoch, generation: Number(second?.generation) };
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

it("restart over the same agent directory resumes above the previous generation", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const dir = await fs.mkdtemp(join(tmpdir(), "r99-restart-"));
	const sessionPath = join(dir, "session.jsonl");
	const open = async () => {
		await using rig = createInProcessRig(dir);
		await connect(rig, "peer");
		const reply = await rig.send("peer", {
			type: "open_session",
			id: "open",
			cwd: dir,
			sessionPath,
			admissionId: "a",
		});
		expect(reply?.success).toBe(true);
		const entry = rig.registry.peek(String(reply?.sessionId));
		entry?.runtime?.session.sessionManager.appendMessage({ role: "user", content: "persist", timestamp: 1 });
		return { generation: Number(reply?.generation), durable: entry?.durableSessionId };
	};
	try {
		const first = await open();
		const second = await open();
		expect(second.durable).toBe(first.durable);
		expect(second.generation).toBeGreaterThan(first.generation);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

it.each([false, true])(
	"publication waits for durable reservation; failure=%s refuses without a token",
	async (fail) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		const dir = await fs.mkdtemp(join(tmpdir(), "r99-publish-"));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const rename = vi.mocked(fs.rename).getMockImplementation();
		if (!rename) throw new Error("missing real rename");
		vi.mocked(fs.rename).mockImplementation(async (from, to) => {
			if (String(to).includes(".senpi-recovery-generations-")) {
				entered.resolve();
				await release.promise;
				if (fail) throw new Error("injected durable generation failure");
			}
			await rename(from, to);
		});
		try {
			await using rig = createInProcessRig(dir);
			await connect(rig, "peer");
			const opening = rig.send("peer", {
				type: "open_session",
				id: "open",
				cwd: dir,
				admissionId: "a",
			});
			try {
				// On the old engine the open wins without ever touching durable generation storage.
				expect(await Promise.race([entered.promise.then(() => "persist"), opening.then(() => "published")])).toBe(
					"persist",
				);
				expect(rig.records().some((record) => record.id === "open" || record.type === "recovery_manifest")).toBe(
					false,
				);
			} finally {
				release.resolve();
			}
			const reply = await opening;
			if (fail) {
				expect(reply).toMatchObject({ success: false, error: "admission_storage_unavailable" });
				expect(reply).not.toHaveProperty("generation");
				expect(rig.records().some((record) => record.type === "recovery_manifest")).toBe(false);
			} else {
				expect(reply?.success).toBe(true);
				expect(reply?.generation).toBeGreaterThan(0);
			}
		} finally {
			release.resolve();
			await fs.rm(dir, { recursive: true, force: true });
		}
	},
);
