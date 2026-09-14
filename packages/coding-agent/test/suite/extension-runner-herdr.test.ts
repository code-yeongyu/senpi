// Refs #1645: host-discovered event-only extensions must participate in reporter ownership.
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { loadExtensionFromFactory, loadExtensions } from "../../src/core/extensions/loader.ts";
import type { QuestionResponse } from "../../src/core/extensions/types.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness } from "./harness.ts";

const debug = vi.hoisted(() => vi.fn());
vi.mock("node:util", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:util")>()),
	debuglog: (name: string) => (name === "senpi:herdr" ? debug : () => {}),
}));

interface Request {
	method: string;
	params: { state?: string; message?: string; source: string };
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
	debug.mockClear();
});

async function fixture(userReporter: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "runner-herdr-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const agentDir = join(dir, "agent");
	const extensionsDir = join(agentDir, "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const managed = join(extensionsDir, "herdr-agent-state.ts");
	writeFileSync(
		managed,
		"// HERDR_INTEGRATION_ID=pi\nexport default function(pi) { pi.on('session_start', () => {}); }\n",
	);
	const probe = join(extensionsDir, "herdr-user-probe.ts");
	if (userReporter)
		writeFileSync(
			probe,
			"export default function(pi) { pi.on('session_start', (_event, ctx) => { pi.events.emit('probe:loaded', ctx.loadedExtensionPaths); }); }\n",
		);
	const socketPath =
		process.platform === "win32" ? `\\\\.\\pipe\\runner-herdr-${dir.split(/[\\/]/).pop()}` : join(dir, "sock");
	const requests: Request[] = [];
	const received = new EventEmitter();
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			if (!buffer.includes("\n")) return;
			const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
			requests.push(request);
			socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
			received.emit("request", request);
		});
	});
	const listening = once(server, "listening", { signal: AbortSignal.timeout(5000) });
	server.listen(socketPath);
	await listening;
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_SOCKET_PATH", socketPath);
	vi.stubEnv("HERDR_PANE_ID", "pane-test");
	// Relative discovery paths exercise the host's resolved-path handoff, not the process cwd.
	const paths = [managed, ...(userReporter ? [probe] : [])];
	const loaded = await loadExtensions(
		paths.map((path) => `./${relative(dir, path)}`),
		dir,
	);
	expect(loaded.errors).toEqual([]);
	for (const builtin of builtinExtensions.filter(({ id }) => id === "ask-user" || id === "herdr")) {
		loaded.extensions.unshift(
			await loadExtensionFromFactory(
				builtin.factory,
				dir,
				loaded.eventBus!,
				loaded.runtime,
				`<builtin:${builtin.id}>`,
			),
		);
	}
	const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult: loaded }) });
	cleanups.push(harness.cleanup);
	await harness.session.bindExtensions({});
	const runner = harness.getExtensionRunner();
	runner.setUIContext(undefined, "tui");
	cleanups.push(() => runner.emit({ type: "session_shutdown", reason: "quit" }));
	const errors: unknown[] = [];
	runner.onError((error) => errors.push(error));
	const start = async () => {
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(errors).toEqual([]);
	};
	return { paths, requests, received, runner, start };
}

describe("herdr builtin host integration", () => {
	it("registers the reporter immediately after ask-user", () => {
		const index = builtinExtensions.findIndex(({ id }) => id === "ask-user");
		expect(builtinExtensions[index + 1]?.id).toBe("herdr");
	});

	it("hands resolved paths to an actually loaded event-only user extension and defers once", async () => {
		const f = await fixture(true);
		let observed: unknown;
		f.runner.onBusEvent("probe:loaded", (paths) => {
			observed = paths;
		});
		await f.start();
		await f.start();
		expect(observed).toEqual(expect.arrayContaining(f.paths));
		expect(f.runner.createCommandContext().loadedExtensionPaths).toEqual(observed);
		expect(f.requests).toHaveLength(0);
		expect(debug).toHaveBeenCalledTimes(1);
	});

	it.each([true, false])(
		"coexists with managed paths and reports real ask-user registration (wait=%s)",
		async (waitForAnswer) => {
			const f = await fixture(false);
			await f.start();
			expect(f.requests.map(({ method }) => method)).toEqual([
				"pane.report_metadata",
				"pane.report_agent_session",
				"pane.report_agent",
			]);
			expect(f.requests.at(-1)?.params.state).toBe("idle");
			const response = Promise.withResolvers<QuestionResponse>();
			const base = f.runner.createContext();
			const ctx = { ...base, ui: { ...base.ui, question: () => response.promise }, hasUI: true };
			const tool = f.runner.getToolDefinition("ask_user_question")!;
			const controller = new AbortController();
			cleanups.push(() => controller.abort());
			const blocked = once(f.received, "request", { signal: AbortSignal.timeout(5000) });
			const execution = tool.execute(
				"qa-question",
				{
					waitForAnswer,
					questions: [
						{
							id: "q1",
							header: "Auth",
							question: "Which flow?",
							options: [{ label: "OAuth" }, { label: "Token" }],
							multiSelect: false,
						},
					],
				},
				controller.signal,
				undefined,
				ctx,
			);
			await blocked;
			expect(f.requests.at(-1)?.params).toMatchObject({
				source: "custom:senpi",
				state: "blocked",
				message: "Auth — Which flow?",
			});
			const settled = once(f.received, "request", { signal: AbortSignal.timeout(5000) });
			response.resolve({ status: "cancelled", answers: {}, unanswered: ["q1"] });
			await settled;
			await execution;
			expect(f.requests.at(-1)?.params.state).toBe("idle");
			expect(debug).not.toHaveBeenCalled();
		},
	);
});
