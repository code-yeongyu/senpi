/**
 * The order of a terminal endpoint's registration, forced with held promises: the writer stamp's
 * process lookup starts before the session header is durable, the socket is bound while the header is
 * still being written, and `endpoint.json` - what makes the endpoint visible - appears only after it.
 */
import { vi } from "vitest";

const seams = vi.hoisted(() => ({
	startTime: undefined as (() => Promise<string | null>) | undefined,
	bound: [] as Array<(socket: string) => void>,
	onRegister: undefined as (() => void) | undefined,
}));

vi.mock("../../src/modes/rpc/host-daemon-registration.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modes/rpc/host-daemon-registration.ts")>();
	return { ...actual, thisProcessStartTime: () => seams.startTime?.() ?? actual.thisProcessStartTime() };
});

vi.mock("../../src/modes/interactive/session-control-server.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modes/interactive/session-control-server.ts")>();
	return {
		...actual,
		listenControlSocket: async (...args: Parameters<typeof actual.listenControlSocket>) => {
			const server = await actual.listenControlSocket(...args);
			for (const waiter of seams.bound.splice(0)) waiter(args[0]);
			return server;
		},
	};
});

vi.mock("../../src/modes/interactive/session-control-registry.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modes/interactive/session-control-registry.ts")>();
	return {
		...actual,
		registerTuiEndpoint: async (...args: Parameters<typeof actual.registerTuiEndpoint>) => {
			seams.onRegister?.();
			return actual.registerTuiEndpoint(...args);
		},
	};
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { readHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";
import { listHostEndpoints } from "../../src/modes/rpc/host-endpoints.ts";
import { socketSecretPath } from "../../src/modes/rpc/socket-transport.ts";
import { controlData } from "../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { within } from "../helpers/tui-endpoint-seams.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	seams.startTime = undefined;
	seams.bound.length = 0;
	seams.onRegister = undefined;
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function ownedHarness(): Promise<Harness> {
	const harness = await createHarness({ persistSession: true });
	cleanups.push(() => harness.cleanup());
	return harness;
}

/** Registration started now; whatever it ends in, the endpoint it made is disposed after the test. */
function registering(harness: Harness): Promise<EndpointFixture> {
	const started = startEndpoint({ harness });
	cleanups.push(() => started.then((fixture) => fixture.endpoint.dispose()).catch(() => undefined));
	return started;
}

/** Holds the session header write until `release`; `fail` makes it reject instead. */
function holdHeader(harness: Harness) {
	const manager = harness.session.sessionManager;
	const original = manager.persistHeaderNow.bind(manager);
	const released = Promise.withResolvers<"write" | "fail">();
	let durable = false;
	vi.spyOn(manager, "persistHeaderNow").mockImplementation(async () => {
		if ((await released.promise) === "fail") throw new Error("header write refused");
		await original();
		durable = true;
	});
	cleanups.push(() => released.resolve("write"));
	return { release: () => released.resolve("write"), fail: () => released.resolve("fail"), durable: () => durable };
}

function nextBind(): Promise<string> {
	return new Promise((resolve) => seams.bound.push(resolve));
}

describe.skipIf(process.platform === "win32")("tui endpoint registration order", () => {
	it("starts the writer stamp's process lookup before the session header is durable", async () => {
		const harness = await ownedHarness();
		const header = holdHeader(harness);
		const { thisProcessStartTime: realStartTime } = await vi.importActual<
			typeof import("../../src/modes/rpc/host-daemon-registration.ts")
		>("../../src/modes/rpc/host-daemon-registration.ts");
		const lookedUp = Promise.withResolvers<void>();
		const stamp = Promise.withResolvers<string | null>();
		seams.startTime = () => {
			lookedUp.resolve();
			return stamp.promise;
		};

		const registration = registering(harness);
		await within(lookedUp.promise, 5_000, "the start-time lookup while the header is held");
		expect(header.durable()).toBe(false);

		const startTime = await realStartTime();
		expect(startTime).toEqual(expect.any(String));
		header.release();
		stamp.resolve(startTime);
		const fixture = await within(registration, 10_000, "registration");
		const registered = await readHostRegistration(
			createHostDaemonPaths({ socket: fixture.socket, agentDir: fixture.agentDir }),
		);
		expect(registered?.record).toMatchObject({ pid: process.pid, processStartTime: startTime });
		expect(registered?.writer).toEqual({ pid: process.pid, startTime });
	});

	it("binds the socket while the header is written and publishes endpoint.json only once it is durable", async () => {
		const harness = await ownedHarness();
		const header = holdHeader(harness);
		// Seen at the registry write itself: an unguarded registration reaches it within microtasks of the
		// bind, before this test could release the header, so a missing or late gate records `false`.
		const durableAtRegister: boolean[] = [];
		seams.onRegister = () => durableAtRegister.push(header.durable());
		const bound = nextBind();
		const registration = registering(harness);

		const socket = await within(bound, 5_000, "the bind while the header is held");
		expect(await controlData(socket, { type: "get_protocol_info" })).toMatchObject({ mode: "tui" });
		const agentDir = join(harness.tempDir, "agent");
		const paths = createHostDaemonPaths({ socket, agentDir });
		expect(header.durable()).toBe(false);
		expect(existsSync(paths.endpointFile)).toBe(false);
		expect(await listHostEndpoints(agentDir)).toEqual([]);

		header.release();
		const fixture = await within(registration, 10_000, "registration");
		expect(fixture.socket).toBe(socket);
		expect(durableAtRegister).toEqual([true]);
		expect(existsSync(paths.endpointFile)).toBe(true);
		expect((await listHostEndpoints(agentDir)).map((entry) => entry.socket)).toEqual([socket]);
		const [headerLine] = readFileSync(harness.sessionManager.getSessionFile() ?? "", "utf8").split("\n");
		expect(JSON.parse(headerLine ?? "{}")).toMatchObject({ type: "session", id: harness.session.sessionId });
	});

	it("leaves no socket, secret or endpoint when the header cannot be written", async () => {
		const harness = await ownedHarness();
		const header = holdHeader(harness);
		const bound = nextBind();
		const registration = registering(harness);
		const socket = await within(bound, 5_000, "the bind while the header is held");

		header.fail();
		expect(
			await registration.then(
				() => "resolved",
				(error: unknown) => String(error),
			),
		).toContain("header write refused");
		expect(existsSync(socket)).toBe(false);
		expect(existsSync(socketSecretPath(socket))).toBe(false);
		expect(await listHostEndpoints(join(harness.tempDir, "agent"))).toEqual([]);
	});
});
