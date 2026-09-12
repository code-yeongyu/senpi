import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createMcpExtension } from "../../src/core/extensions/builtin/mcp/index.ts";
import { McpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { Extension, SessionStartEvent } from "../../src/core/extensions/types.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

class SlowAttachMcpService extends McpService {
	connectCompleted = false;
	readonly #connectStarted: Deferred;
	readonly #connectGate: Deferred;

	constructor(connectStarted: Deferred, connectGate: Deferred) {
		super();
		this.#connectStarted = connectStarted;
		this.#connectGate = connectGate;
	}

	override async attachSession(): Promise<void> {
		this.#connectStarted.resolve();
		await this.#connectGate.promise;
		this.connectCompleted = true;
	}
}

const services: McpService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose("quit")));
	resetMcpServiceForTests();
});

describe("mcp session_start reload deferral", () => {
	it("resolves session_start before reconnect completes when reason is reload", async () => {
		const { extension, service, connectStarted, connectGate } = await loadSlowAttachExtension();

		// Given: attachSession is blocked at the connect seam.
		let sessionStartResolved = false;
		const sessionStart = emitSessionStart(extension, "reload").then(() => {
			sessionStartResolved = true;
		});

		// When: session_start is emitted with reason reload.
		await connectStarted.promise;
		await drainMicrotasks();

		// Then: the handler settles while reconnect is still in flight.
		expect(sessionStartResolved).toBe(true);
		expect(service.connectCompleted).toBe(false);

		connectGate.resolve();
		await sessionStart;
		expect(service.connectCompleted).toBe(true);
	});

	it("awaits reconnect during session_start when reason is startup", async () => {
		const { extension, service, connectStarted, connectGate } = await loadSlowAttachExtension();

		// Given: attachSession is blocked at the connect seam.
		let sessionStartResolved = false;
		const sessionStart = emitSessionStart(extension, "startup").then(() => {
			sessionStartResolved = true;
		});

		// When: session_start is emitted with reason startup.
		await connectStarted.promise;
		await drainMicrotasks();

		// Then: the handler stays pending until reconnect completes.
		expect(sessionStartResolved).toBe(false);
		expect(service.connectCompleted).toBe(false);

		connectGate.resolve();
		await sessionStart;
		expect(service.connectCompleted).toBe(true);
	});

	it("awaits reconnect during session_start when reason is omitted", async () => {
		const { extension, service, connectStarted, connectGate } = await loadSlowAttachExtension();

		let sessionStartResolved = false;
		const sessionStart = emitSessionStart(extension, undefined).then(() => {
			sessionStartResolved = true;
		});
		await connectStarted.promise;
		await drainMicrotasks();

		expect(sessionStartResolved).toBe(false);
		expect(service.connectCompleted).toBe(false);

		connectGate.resolve();
		await sessionStart;
		expect(service.connectCompleted).toBe(true);
	});
});

async function loadSlowAttachExtension(): Promise<{
	readonly extension: Extension;
	readonly service: SlowAttachMcpService;
	readonly connectStarted: Deferred;
	readonly connectGate: Deferred;
}> {
	const connectStarted = createDeferred();
	const connectGate = createDeferred();
	const service = new SlowAttachMcpService(connectStarted, connectGate);
	services.push(service);
	const extension = await loadExtensionFromFactory(
		createMcpExtension(service, true),
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<builtin:mcp>",
	);
	return { extension, service, connectStarted, connectGate };
}

function emitSessionStart(extension: Extension, reason: SessionStartEvent["reason"] | undefined): Promise<void> {
	const event =
		reason === undefined
			? ({ type: "session_start" } as SessionStartEvent)
			: { type: "session_start" as const, reason };
	return emit(extension, event);
}

async function emit(extension: Extension, event: SessionStartEvent): Promise<void> {
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler(event, { cwd: process.cwd(), isProjectTrusted: () => true });
	}
}

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
