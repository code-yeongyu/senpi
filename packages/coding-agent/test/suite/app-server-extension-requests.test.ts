import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { createAppServerRuntime } from "../../src/modes/app-server/runtime.ts";

const roots: string[] = [];

function fixture(extensionSources: readonly string[]): { readonly root: string; readonly agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-app-server-extension-requests-"));
	const agentDir = join(root, "agent");
	const extensionsDir = join(agentDir, "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	for (const [index, source] of extensionSources.entries()) {
		writeFileSync(join(extensionsDir, `rpc-request-${index}.ts`), source, "utf8");
	}
	roots.push(root);
	return { root, agentDir };
}

async function startRuntime(extensionSources: readonly string[]) {
	const created = fixture(extensionSources);
	vi.stubEnv("SENPI_CODING_AGENT_DIR", created.agentDir);
	vi.stubEnv("SENPI_CODING_AGENT_SESSION_DIR", join(created.root, "sessions"));
	vi.stubEnv("PI_OFFLINE", "1");
	const runtime = createAppServerRuntime(() => undefined);
	const frames: RpcEnvelope[] = [];
	const connection = runtime.core.addConnection({
		id: "client",
		transportKind: "stdio",
		send: (message) => {
			frames.push(message);
		},
		close: () => undefined,
	});
	await runtime.core.receive(connection.id, {
		kind: "request",
		message: {
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "request-test", version: "1.0.0" }, capabilities: {} },
		},
	});
	await runtime.core.receive(connection.id, {
		kind: "request",
		message: { id: 2, method: "thread/start", params: { cwd: created.root } },
	});
	const started = frames.find((frame) => "id" in frame && frame.id === 2);
	if (!started || !("result" in started) || typeof started.result !== "object" || started.result === null) {
		throw new Error("thread/start response missing");
	}
	const thread = Reflect.get(started.result, "thread");
	const threadId = typeof thread === "object" && thread !== null ? Reflect.get(thread, "id") : undefined;
	if (typeof threadId !== "string") throw new Error("thread/start response missing thread id");
	return { runtime, frames, connectionId: connection.id, threadId };
}

async function extensionRequest(
	harness: Awaited<ReturnType<typeof startRuntime>>,
	id: number,
	name: string,
	data?: unknown,
): Promise<RpcEnvelope> {
	await harness.runtime.core.receive(harness.connectionId, {
		kind: "request",
		message: { id, method: "extension_request", params: { threadId: harness.threadId, name, data } },
	});
	const response = harness.frames.find((frame) => "id" in frame && frame.id === id);
	if (!response) throw new Error(`missing extension_request response ${id}`);
	return response;
}

describe("app-server extension RPC requests", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("round-trips structured data through the owning thread extension handler", async () => {
		// Given: an app-server thread whose extension handles fixture.echo.
		const harness = await startRuntime([
			`export default function (pi) { pi.rpc.handle("fixture.echo", async (data) => ({ echoed: data })); }`,
		]);

		// When: the client sends an extension_request for that thread.
		const response = await extensionRequest(harness, 3, "fixture.echo", { text: "hello" });

		// Then: the handler result is returned as the JSON-RPC result.
		expect(response).toEqual({ id: 3, result: { echoed: { text: "hello" } } });
		harness.runtime.dispose();
	});

	it("returns a typed JSON-RPC error for an unknown handler", async () => {
		// Given: an app-server thread with no matching extension handler.
		const harness = await startRuntime([]);

		// When: the client requests an unknown extension RPC name.
		const response = await extensionRequest(harness, 3, "fixture.missing");

		// Then: the registry returns a bounded typed error instead of throwing through the server.
		expect(response).toEqual({
			id: 3,
			error: { code: -32603, message: "Unknown extension RPC request: fixture.missing" },
		});
		harness.runtime.dispose();
	});

	it("returns a typed JSON-RPC error when multiple handlers share one name", async () => {
		// Given: two extensions registering the same request name.
		const source = `export default function (pi) { pi.rpc.handle("fixture.duplicate", () => null); }`;
		const harness = await startRuntime([source, source]);

		// When: the client requests that ambiguous name.
		const response = await extensionRequest(harness, 3, "fixture.duplicate");

		// Then: single-handler semantics surface as a typed JSON-RPC error.
		expect(response).toEqual({
			id: 3,
			error: { code: -32603, message: "Multiple extension RPC request handlers registered: fixture.duplicate" },
		});
		harness.runtime.dispose();
	});
});
