import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { createAppServerRuntime } from "../../src/modes/app-server/runtime.ts";

const roots: string[] = [];

function createFixture(): { readonly root: string; readonly agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-app-server-extension-events-"));
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(agentDir, "extensions", "rpc-events.ts"),
		`export default function (pi) {
			pi.on("session_start", () => pi.rpc.emit("fixture.ready", { ready: true }));
		}
`,
		"utf8",
	);
	roots.push(root);
	return { root, agentDir };
}

async function request(
	runtime: ReturnType<typeof createAppServerRuntime>,
	connectionId: string,
	id: number,
	method: string,
	params: unknown,
): Promise<void> {
	await runtime.core.receive(connectionId, { kind: "request", message: { id, method, params } });
}

describe("app-server extension RPC events", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("forwards one session-start extension event only to the owning thread subscribers", async () => {
		// Given: two initialized app-server clients and a test extension that emits during binding.
		const fixture = createFixture();
		vi.stubEnv("SENPI_CODING_AGENT_DIR", fixture.agentDir);
		vi.stubEnv("SENPI_CODING_AGENT_SESSION_DIR", join(fixture.root, "sessions"));
		vi.stubEnv("PI_OFFLINE", "1");
		const runtime = createAppServerRuntime(() => undefined);
		const firstFrames: RpcEnvelope[] = [];
		const secondFrames: RpcEnvelope[] = [];
		for (const [id, frames] of [
			["first", firstFrames],
			["second", secondFrames],
		] as const) {
			runtime.core.addConnection({
				id,
				transportKind: "stdio",
				send: (message) => {
					frames.push(message);
				},
				close: () => undefined,
			});
			await request(runtime, id, 1, "initialize", {
				clientInfo: { name: id, version: "1.0.0" },
				capabilities: {},
			});
		}

		// When: only the first client starts and subscribes to a thread.
		await request(runtime, "first", 2, "thread/start", { cwd: fixture.root });

		// Then: exactly one extension record reaches that owner and no unrelated client.
		expect(firstFrames.filter((frame) => "method" in frame && frame.method === "extension_event")).toEqual([
			expect.objectContaining({
				method: "extension_event",
				params: {
					type: "extension_event",
					name: "fixture.ready",
					data: { ready: true },
					threadId: expect.any(String),
				},
			}),
		]);
		expect(secondFrames.filter((frame) => "method" in frame && frame.method === "extension_event")).toEqual([]);
		runtime.dispose();
	});
});
