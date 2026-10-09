import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { createAppServerRuntime } from "../../src/modes/app-server/runtime.ts";

const roots: string[] = [];

// The extension lives outside the agent dir, so only an explicit --extension path can load it:
// the case of a product launcher (omo) that ships its plugin next to the engine.
function createFixture(): { readonly root: string; readonly extensionPath: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-app-server-extension-paths-"));
	mkdirSync(join(root, "agent"), { recursive: true });
	const extensionPath = join(root, "plugin", "probe.ts");
	mkdirSync(join(root, "plugin"), { recursive: true });
	writeFileSync(
		extensionPath,
		`export default function (pi) {
			pi.registerTool({
				name: "fixture_probe",
				label: "Fixture probe",
				description: "Proves the extension loaded",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			pi.on("session_start", () => pi.rpc.emit("fixture.loaded", { loaded: true }));
		}
`,
		"utf8",
	);
	roots.push(root);
	return { root, extensionPath };
}

async function startThread(
	extensionPaths: readonly string[] | undefined,
	root: string,
): Promise<{ runtime: ReturnType<typeof createAppServerRuntime>; frames: RpcEnvelope[]; threadId: string }> {
	vi.stubEnv("SENPI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("SENPI_CODING_AGENT_SESSION_DIR", join(root, "sessions"));
	vi.stubEnv("PI_OFFLINE", "1");
	const runtime =
		extensionPaths === undefined
			? createAppServerRuntime(() => undefined)
			: createAppServerRuntime(() => undefined, { extensionPaths });
	const frames: RpcEnvelope[] = [];
	runtime.core.addConnection({
		id: "client",
		transportKind: "stdio",
		send: (message) => {
			frames.push(message);
		},
		close: () => undefined,
	});
	await runtime.core.receive("client", {
		kind: "request",
		message: {
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "client", version: "1.0.0" }, capabilities: {} },
		},
	});
	await runtime.core.receive("client", {
		kind: "request",
		message: { id: 2, method: "thread/start", params: { cwd: root } },
	});
	const started = frames.find((frame) => "id" in frame && frame.id === 2 && "result" in frame);
	const thread = started && "result" in started ? Reflect.get(Object(started.result), "thread") : undefined;
	const threadId = thread ? Reflect.get(Object(thread), "id") : undefined;
	if (typeof threadId !== "string") throw new Error("thread/start response missing thread id");
	return { runtime, frames, threadId };
}

function fixtureEvents(frames: readonly RpcEnvelope[]): RpcEnvelope[] {
	return frames.filter(
		(frame) =>
			"method" in frame &&
			frame.method === "extension_event" &&
			"params" in frame &&
			Reflect.get(Object(frame.params), "name") === "fixture.loaded",
	);
}

describe("app-server extension paths (omo#9117)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("loads --extension paths into every thread session: tools registered and rpc events forwarded", async () => {
		// Given: an extension that is reachable only through an explicit path.
		const fixture = createFixture();

		// When: the runtime is created with that path and a client starts a thread.
		const { runtime, frames, threadId } = await startThread([fixture.extensionPath], fixture.root);

		// Then: the thread session carries the extension tool and its session_start event reaches the client.
		expect(
			runtime.threads
				.getLoadedThread(threadId)
				.session.getAllTools()
				.map((tool) => tool.name),
		).toContain("fixture_probe");
		expect(fixtureEvents(frames)).toEqual([
			expect.objectContaining({
				params: { type: "extension_event", name: "fixture.loaded", data: { loaded: true }, threadId },
			}),
		]);
		runtime.dispose();
	});

	it("loads nothing extra when no extension paths are given", async () => {
		// Given: the same extension on disk but no path handed to the runtime.
		const fixture = createFixture();

		// When: a thread starts on a runtime without extension paths.
		const { runtime, frames, threadId } = await startThread(undefined, fixture.root);

		// Then: the out-of-tree extension is not loaded.
		expect(
			runtime.threads
				.getLoadedThread(threadId)
				.session.getAllTools()
				.map((tool) => tool.name),
		).not.toContain("fixture_probe");
		expect(fixtureEvents(frames)).toEqual([]);
		runtime.dispose();
	});
});
