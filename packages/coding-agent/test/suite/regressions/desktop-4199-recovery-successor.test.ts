import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { HostEnsureRefusedError } from "../../../src/modes/rpc/host-decision.ts";
import { startHost } from "../../../src/modes/rpc/host-ensure-start.ts";
import { DEFAULT_HOST_LAUNCH_SPEC } from "../../../src/modes/rpc/host-launch-spec.ts";
import { HOST_EXIT_REFUSED, runHostRequest } from "../../../src/modes/rpc/host-runner.ts";
import {
	acquireOwnerPresence,
	claimLaunchRole,
	grantVerifiedParticipant,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import { createSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { fakeWindows } from "../../helpers/fake-windows-presence.ts";

const mocked = vi.hoisted(() => ({
	lockDir: "",
	placement: undefined as unknown,
	events: [] as string[],
	ensureRefusal: undefined as unknown,
}));

vi.mock("../../../src/modes/rpc/host-ensure.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/host-ensure.ts")>();
	return {
		...actual,
		ensureHost: vi.fn(async (...args: Parameters<typeof actual.ensureHost>) => {
			if (mocked.ensureRefusal !== undefined) throw mocked.ensureRefusal;
			return actual.ensureHost(...args);
		}),
	};
});

vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(mocked.lockDir, "endpoint"),
}));

vi.mock("../../../src/modes/rpc/socket-secret-native.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/socket-secret-native.ts")>();
	return {
		...actual,
		loadPresencePlacement: vi.fn((...args: Parameters<typeof actual.loadPresencePlacement>) =>
			mocked.placement === undefined ? actual.loadPresencePlacement(...args) : mocked.placement,
		),
	};
});

vi.mock("../../../src/modes/rpc/socket-transport.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/socket-transport.ts")>();
	return {
		...actual,
		ensureSocketSecret: vi.fn(async (...args: Parameters<typeof actual.ensureSocketSecret>) => {
			mocked.events.push("credential mutation");
			return actual.ensureSocketSecret(...args);
		}),
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Recovery transaction
// order" step 5 and "Crash, cancellation and commit"; test 11 at the startHost entry). Security contract: a Windows
// public-endpoint start that finds an earlier generation not retired first runs the recovery transaction under its
// endpoint lock, BEFORE it acquires its own presence, mutates the credential or reserves; a generation whose authority
// is not proven ended refuses typed (`reservation_recovery_required`, with the recovery reason and generation) with zero
// credential mutation, reservation or spawn; a recovered endpoint admits exactly one successor. A generation that served
// and whose actors exited retires at the next start, so an ordinary restart is not refused.
const OWNER = { pid: 100, processStartTime: "134000000000000000" };
const SUPERVISOR = { pid: 4242, processStartTime: "134000000000000001" };
const SECRET = Buffer.alloc(32, 7);

describe("#4199 recovery before exactly one successor at startHost", () => {
	const roots: string[] = [];
	const stores: EndpointReservationStore[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		mocked.placement = undefined;
		mocked.ensureRefusal = undefined;
		mocked.events.length = 0;
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	/** An endpoint whose earlier launch reached a granted supervisor; the fake machine still holds both locks. */
	async function endpointWithEarlierLaunch(
		fake: ReturnType<typeof fakeWindows>,
		expectedRoles: readonly ("supervisor" | "host")[] = ["supervisor", "host"],
	) {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-successor-"));
		roots.push(root);
		mocked.lockDir = root;
		mocked.placement = fake.load;
		const socket = join(root, "rpc.sock");
		await createSocketSecret(socketSecretPath(socket));
		const target = join(root, "endpoint");
		const store = await openEndpointReservationStore(`${target}.reservation.db`);
		stores.push(store);
		const reservation = resolvePresenceRoot({
			coordinationTarget: target,
			endpointKey: basename(target),
			native: fake.load,
		});
		const ownerPresence = acquireOwnerPresence(reservation, fake.load);
		const { generation, args } = offerSupervisorLaunch(
			store,
			socket,
			OWNER,
			{ reservation, native: fake.load, ownerPresence },
			expectedRoles,
		);
		const locator = parseReservationLocatorArgs(args);
		if (!locator) throw new Error("no locator");
		await claimLaunchRole(locator, SUPERVISOR, fake.load);
		grantVerifiedParticipant(
			store,
			generation,
			"supervisor",
			OWNER,
			SUPERVISOR,
			createHash("sha256").update(SECRET).digest(),
		);
		const agentDir = join(root, "agent");
		const paths = await createHostDaemonPaths({ agentDir, socket });
		return { root, socket, agentDir, paths, store, generation, locator };
	}

	/** startHost on a Windows endpoint whose supervisor spawn is replaced by a sentinel throw. */
	async function startUntilSpawn(
		fake: ReturnType<typeof fakeWindows>,
		endpoint: Awaited<ReturnType<typeof endpointWithEarlierLaunch>>,
	) {
		const reserve = EndpointReservationStore.prototype.reserve;
		vi.spyOn(EndpointReservationStore.prototype, "reserve").mockImplementation(function (
			this: EndpointReservationStore,
			...args
		) {
			mocked.events.push("reserve");
			return reserve.apply(this, args);
		});
		const retire = EndpointReservationStore.prototype.retire;
		vi.spyOn(EndpointReservationStore.prototype, "retire").mockImplementation(function (
			this: EndpointReservationStore,
			...args
		) {
			mocked.events.push("retire");
			return retire.apply(this, args);
		});
		const reachedSpawn = new Error("start reached the supervisor spawn");
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
		let outcome: unknown;
		await vi.mocked(childProcess.spawn).withImplementation(
			() => {
				mocked.events.push("spawn");
				throw reachedSpawn;
			},
			async () => {
				fake.calls.length = 0;
				outcome = await startHost(endpoint.paths, endpoint.socket, {
					agentDir: endpoint.agentDir,
					socket: endpoint.socket,
				}).catch((error: unknown) => error);
			},
		);
		vi.unstubAllGlobals();
		return { outcome, reachedSpawn };
	}

	it("test 11: an abandoned generation is recovered and retired before the owner's lock, the credential and exactly one successor", async () => {
		const fake = fakeWindows({ onAcquire: (request) => mocked.events.push(`acquire ${request.presenceId}`) });
		const endpoint = await endpointWithEarlierLaunch(fake);
		// The launcher and its supervisor crashed: their kernel handles closed.
		fake.held.clear();
		mocked.events.length = 0;
		const { outcome, reachedSpawn } = await startUntilSpawn(fake, endpoint);
		expect(outcome).toBe(reachedSpawn);
		expect(endpoint.store.reservation(endpoint.generation).state).toBe("retired");
		const retireAt = mocked.events.indexOf("retire");
		const credentialAt = mocked.events.indexOf("credential mutation");
		expect(retireAt).toBeGreaterThan(-1);
		expect(mocked.events.slice(retireAt + 1)).toEqual([
			expect.stringMatching(/^acquire /),
			"credential mutation",
			"reserve",
			"spawn",
		]);
		expect(credentialAt).toBeGreaterThan(retireAt);
		const [successor, ...others] = endpoint.store.activeGenerations(endpoint.socket);
		expect(others).toEqual([]);
		expect(successor).not.toBe(endpoint.generation);
	});

	it("test 11: a granted participant still holding its object refuses the start typed, with no credential mutation, reservation or spawn", async () => {
		const fake = fakeWindows();
		const endpoint = await endpointWithEarlierLaunch(fake);
		const supervisor = endpoint.store.roleRow(endpoint.locator)?.presence;
		if (supervisor?.status !== "predeclared") throw new Error("expected an object");
		// Only the launcher died; its supervisor is alive, paused before bind.
		for (const [path, id] of fake.held) if (id !== supervisor.presenceId) fake.held.delete(path);
		mocked.events.length = 0;
		const { outcome } = await startUntilSpawn(fake, endpoint);
		expect(outcome).toBeInstanceOf(HostEnsureRefusedError);
		expect(outcome).toMatchObject({
			reason: "reservation_recovery_required",
			recovery: { reason: "presence_occupied", generation: endpoint.generation },
		});
		expect(mocked.events.filter((event) => event !== "retire")).toEqual([]);
		expect(mocked.events).not.toContain("retire");
		expect(endpoint.store.activeGenerations(endpoint.socket)).toEqual([endpoint.generation]);
		expect([...fake.held.values()]).toEqual([supervisor.presenceId]);
	});

	it("the `host ensure` payload carries the typed recovery refusal (reason, generation and Repair action)", async () => {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-successor-payload-"));
		roots.push(root);
		const socket = join(root, "rpc.sock");
		const recovery = {
			reason: "presence_occupied",
			generation: "0123456789abcdef0123456789abcdef",
			action: "wait_for_owner",
		} as const;
		mocked.ensureRefusal = new HostEnsureRefusedError(
			socket,
			"reservation_recovery_required",
			undefined,
			"presence_occupied in generation 0123456789abcdef0123456789abcdef: supervisor (pid 4242)",
			undefined,
			recovery,
		);
		const outcome = await runHostRequest({
			action: "ensure",
			target: { socket, agentDir: join(root, "agent") },
			spec: DEFAULT_HOST_LAUNCH_SPEC,
			policy: "never",
		});
		expect(outcome.exitCode).toBe(HOST_EXIT_REFUSED);
		expect(outcome.payload).toMatchObject({ action: "refuse", reason: "reservation_recovery_required", recovery });
	});

	it("an ordinary restart: a generation that served and whose actors exited retires at the next start", async () => {
		const fake = fakeWindows();
		// A legacy host keeps its legacy launch, so this generation expects only the supervisor role.
		const endpoint = await endpointWithEarlierLaunch(fake, ["supervisor"]);
		endpoint.store.markServing(endpoint.generation);
		endpoint.store.releaseOwner(endpoint.generation, JSON.stringify(OWNER));
		endpoint.store.release(endpoint.generation, "supervisor", JSON.stringify(SUPERVISOR));
		fake.held.clear();
		const { outcome, reachedSpawn } = await startUntilSpawn(fake, endpoint);
		expect(outcome).toBe(reachedSpawn);
		expect(endpoint.store.reservation(endpoint.generation)).toMatchObject({
			state: "retired",
			retirement: { discharges: { owner: "released", supervisor: "released" } },
		});
		// Nothing needed proof, so nothing was probed.
		expect(fake.calls.filter((call) => call.startsWith("presenceProbe")).length).toBe(1);
	});
});
