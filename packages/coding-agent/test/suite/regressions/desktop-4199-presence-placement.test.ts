import * as childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ENDPOINT_RESERVATION_SCHEMA,
	type EndpointReservationStore,
	openEndpointReservationStore,
	type ReservationPresence,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { startHost } from "../../../src/modes/rpc/host-ensure-start.ts";
import {
	acquireOwnerPresence,
	claimLaunchRole,
	offerHostRole,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	reservationStorePath,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { PresencePlacementError, resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import { loadPresencePlacement } from "../../../src/modes/rpc/socket-secret-native.ts";
import { createSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { FAKE_KERNEL_SESSION, FAKE_LOCAL_APP_DATA, fakeWindows } from "../../helpers/fake-windows-presence.ts";

const mocked = vi.hoisted(() => ({ lockDir: "", placement: undefined as unknown }));

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

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a, Revision 6
// "Lifetime object and binding" and Revision 7/8 "Placement."). Security contract: the reserving owner resolves the
// presence root ONCE (beside a local store, else a per-user root under FOLDERID_LocalAppData keyed by the canonical
// endpoint, else presence_unavailable without refusing startup) and records its canonical path, physical identity,
// classification and its own kernel-session identity. Every offer predeclares its role's presence object, created and
// flushed before the offer commits and so before any spawn, and carries its recorded location. Issuers and participants
// open the RECORDED directory, require it local and identical, and never re-resolve; a different physical directory is a
// typed failure, never a second exclusion domain. Presence objects are created new and never replaced.
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const LOCK_DIR = "C:\\Users\\u\\AppData\\Local\\Temp\\senpi-rpc-host-locks";
const ENDPOINT_KEY = "0123456789abcdef0123456789abcdef";
const TARGET = `${LOCK_DIR}\\${ENDPOINT_KEY}`;
const LOCAL_APP_DATA = FAKE_LOCAL_APP_DATA;
const SESSION = FAKE_KERNEL_SESSION;
const OWNER = { pid: 100, processStartTime: "133000000000000001" };
const SUPERVISOR = { pid: 200, processStartTime: "133000000000000002" };

function locatorOf(args: readonly string[]) {
	const locator = parseReservationLocatorArgs(args);
	if (locator === undefined) throw new Error("the launch args carry no reservation locator");
	return locator;
}

async function rejectionOf(run: () => unknown): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof PresencePlacementError) return error.reason;
		throw error;
	}
	throw new Error("expected a presence placement rejection");
}

describe("#4199 presence placement", () => {
	const roots: string[] = [];
	const stores: EndpointReservationStore[] = [];

	afterEach(async () => {
		vi.unstubAllGlobals();
		mocked.placement = undefined;
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function openStore() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-placement-"));
		roots.push(root);
		// The endpoint's fixed store beside its (mocked) ensure lock: the one store a claimant's locator may name.
		mocked.lockDir = root;
		const store = await openEndpointReservationStore(reservationStorePath(ENDPOINT));
		stores.push(store);
		return store;
	}

	async function launched(fake: ReturnType<typeof fakeWindows>) {
		const store = await openStore();
		const reservation = resolvePresenceRoot({
			coordinationTarget: TARGET,
			endpointKey: ENDPOINT_KEY,
			native: fake.load,
		});
		const offer = offerSupervisorLaunch(store, ENDPOINT, OWNER, {
			reservation,
			native: fake.load,
			ownerPresence: acquireOwnerPresence(reservation, fake.load),
		});
		return { store, reservation, ...offer, locator: locatorOf(offer.args) };
	}

	it("Placement: a local store keeps presence objects in the private sibling directory beside the coordination target", () => {
		const fake = fakeWindows({ storeLocality: "local" });
		const presence = resolvePresenceRoot({
			coordinationTarget: TARGET,
			endpointKey: ENDPOINT_KEY,
			native: fake.load,
		});
		expect(presence).toEqual<ReservationPresence>({
			root: {
				status: "placed",
				placement: "beside_store",
				path: `\\\\?\\${TARGET}.presence`,
				volumeSerial: "7",
				fileId: "1000",
				classification: "local",
				fileSystem: "NTFS",
			},
			ownerKernelSession: { status: "verified", value: SESSION },
		});
		expect(fake.calls).toContain(`classifyVolume ${LOCK_DIR}`);
		expect(fake.calls).not.toContain("localAppDataPath");
	});

	it("Placement: a not_local store relocates to a per-user root under FOLDERID_LocalAppData keyed by the canonical endpoint", () => {
		const fake = fakeWindows({ storeLocality: "not_local" });
		const { root } = resolvePresenceRoot({
			coordinationTarget: TARGET,
			endpointKey: ENDPOINT_KEY,
			native: fake.load,
		});
		expect(root).toMatchObject({
			status: "placed",
			placement: "relocated",
			path: `\\\\?\\${LOCAL_APP_DATA}\\senpi\\rpc-presence\\${ENDPOINT_KEY}`,
			classification: "local",
		});
		expect(fake.calls).not.toContain(`presenceRootOpen ${TARGET}.presence true`);
	});

	it.each([
		["the per-user root does not classify local", { rootLocality: "not_local" as const }, "root_not_local"],
		["FOLDERID_LocalAppData cannot be resolved", { localAppData: null }, "local_app_data_unavailable"],
	])("Placement: no local root records presence_unavailable when %s", (_label, options, reason) => {
		const fake = fakeWindows({ storeLocality: "not_local", ...options });
		const { root } = resolvePresenceRoot({
			coordinationTarget: TARGET,
			endpointKey: ENDPOINT_KEY,
			native: fake.load,
		});
		expect(root).toMatchObject({ status: "presence_unavailable", reason });
	});

	it("Placement: a row without a local root still starts; its offers record presence_unavailable and no object", async () => {
		const fake = fakeWindows({ storeLocality: "not_local", rootLocality: "not_local" });
		const { store, generation, locator } = await launched(fake);
		expect(store.reservation(generation).presence.root).toMatchObject({ status: "presence_unavailable" });
		expect(store.roleRow(locator)?.presence).toEqual({ status: "presence_unavailable" });
		expect(fake.calls.some((call) => call.startsWith("presenceObjectCreate"))).toBe(false);
		expect(await claimLaunchRole(locator, SUPERVISOR, fake.load)).toMatchObject({ outcome: "claimed" });
	});

	it("Placement: off Windows the root is typed unavailable and startup is not refused for it", async () => {
		const store = await openStore();
		const native = loadPresencePlacement({ platform: "linux" });
		expect(native).toEqual({ status: "unavailable", reason: "unsupported_platform" });
		const reservation = resolvePresenceRoot({ coordinationTarget: TARGET, endpointKey: ENDPOINT_KEY, native });
		expect(reservation).toEqual({
			root: { status: "presence_unavailable", reason: "unsupported_platform", detail: null },
			ownerKernelSession: { status: "unverified", reason: "unsupported_platform" },
		});
		const { generation } = offerSupervisorLaunch(store, ENDPOINT, OWNER, {
			reservation,
			native,
			ownerPresence: acquireOwnerPresence(reservation, native),
		});
		expect(store.reservation(generation).state).toBe("pending");
	});

	it("Placement: the reserving owner records the root's canonical path, physical identity, classification and its kernel session", async () => {
		const fake = fakeWindows();
		const { store, generation, reservation } = await launched(fake);
		expect(ENDPOINT_RESERVATION_SCHEMA).toBe(5);
		expect(store.reservation(generation).presence).toEqual(reservation);
		expect(fake.calls.filter((call) => call.startsWith("classifyVolume"))).toHaveLength(1);
	});

	it("Lifetime object and binding: an offer creates and flushes its role's presence object before the offer commits", async () => {
		const store = await openStore();
		let committedAtCreate: unknown = "not called";
		const fake = fakeWindows({
			onCreate: () => {
				committedAtCreate = generationRef.value
					? store.roleRow({ endpoint: ENDPOINT, generation: generationRef.value, role: "supervisor" })
					: undefined;
			},
		});
		const generationRef: { value?: string } = {};
		const reserve = store.reserve.bind(store);
		vi.spyOn(store, "reserve").mockImplementation((...args) => {
			generationRef.value = reserve(...args);
			return generationRef.value;
		});
		const reservation = resolvePresenceRoot({
			coordinationTarget: TARGET,
			endpointKey: ENDPOINT_KEY,
			native: fake.load,
		});
		const { generation, args } = offerSupervisorLaunch(store, ENDPOINT, OWNER, {
			reservation,
			native: fake.load,
			ownerPresence: acquireOwnerPresence(reservation, fake.load),
		});
		expect(committedAtCreate).toBeUndefined();
		const presence = store.roleRow(locatorOf(args))?.presence;
		if (presence?.status !== "predeclared") throw new Error(`expected a predeclared object, got ${presence?.status}`);
		if (reservation.root.status !== "placed") throw new Error("expected a placed root");
		expect(presence.path).toBe(`${reservation.root.path}\\${presence.presenceId}.presence`);
		expect(fake.objects.get(presence.path)?.content.toString("hex")).toBe(presence.header);
		expect(presence).toMatchObject({
			volumeSerial: "7",
			classification: "local",
			fileSystem: "NTFS",
			kernelSession: { status: "verified", value: SESSION },
		});
		expect(presence.hostLabel).not.toBe("");
		expect(store.reservation(generation).state).toBe("pending");
	});

	it("Placement: every offer carries the recorded location; the issuer opens the RECORDED directory and never re-resolves", async () => {
		const fake = fakeWindows({ storeLocality: "not_local" });
		const { store, generation, reservation } = await launched(fake);
		const resolved = fake.calls.length;
		offerHostRole(store, generation, SUPERVISOR, fake.load);
		const later = fake.calls.slice(resolved);
		expect(later.some((call) => call.startsWith("classifyVolume") || call === "localAppDataPath")).toBe(false);
		const host = store.roleRow({ endpoint: ENDPOINT, generation, role: "host" })?.presence;
		if (host?.status !== "predeclared" || reservation.root.status !== "placed") throw new Error("expected placement");
		expect(host.path.startsWith(`${reservation.root.path}\\`)).toBe(true);
	});

	it("Placement: an issuer that reaches a different physical directory fails with a typed error and offers nothing", async () => {
		const fake = fakeWindows();
		const { store, generation, reservation } = await launched(fake);
		if (reservation.root.status !== "placed") throw new Error("expected a placed root");
		fake.directories.set(reservation.root.path, { volumeSerial: "7", fileId: "4242", locality: "local" });
		expect(await rejectionOf(() => offerHostRole(store, generation, SUPERVISOR, fake.load))).toBe(
			"presence_root_mismatch",
		);
		expect(store.roleRow({ endpoint: ENDPOINT, generation, role: "host" })).toBeUndefined();
	});

	it.each([
		[
			"a different physical directory",
			{ volumeSerial: "7", fileId: "4242", locality: "local" as const },
			"presence_root_mismatch",
		],
		["a directory that no longer classifies local", undefined, "presence_root_not_local"],
	])("Placement: a participant reaching %s fails its claim with a typed error", async (_label, other, reason) => {
		const fake = fakeWindows();
		const { store, reservation, locator } = await launched(fake);
		if (reservation.root.status !== "placed") throw new Error("expected a placed root");
		const recorded = fake.directories.get(reservation.root.path);
		if (!recorded) throw new Error("expected the recorded root");
		fake.directories.set(reservation.root.path, other ?? { ...recorded, locality: "not_local" });
		expect(await rejectionOf(() => claimLaunchRole(locator, SUPERVISOR, fake.load))).toBe(reason);
		expect(store.roleRow(locator)?.status).toBe("offered");
	});

	it("Placement: a participant that cannot open the recorded directory at all cannot claim", async () => {
		const fake = fakeWindows();
		const { store, locator } = await launched(fake);
		const native = loadPresencePlacement({ platform: "linux" });
		expect(await rejectionOf(() => claimLaunchRole(locator, SUPERVISOR, native))).toBe("presence_root_unverifiable");
		expect(store.roleRow(locator)?.status).toBe("offered");
		expect(await claimLaunchRole(locator, SUPERVISOR, fake.load)).toMatchObject({ outcome: "claimed" });
	});

	it.each([
		["exists", "presence_object_exists"],
		["failed", "presence_object_failed"],
	] as const)(
		"Lifetime object and binding: a %s presence object is never replaced and the offer is not committed",
		async (outcome, reason) => {
			const fake = fakeWindows();
			const { store, generation } = await launched(fake);
			const failing = fakeWindows({ createOutcome: outcome });
			for (const [path, directory] of fake.directories) failing.directories.set(path, directory);
			expect(await rejectionOf(() => offerHostRole(store, generation, SUPERVISOR, failing.load))).toBe(reason);
			expect(failing.calls.filter((call) => call.startsWith("presenceObjectCreate"))).toHaveLength(1);
			expect(store.roleRow({ endpoint: ENDPOINT, generation, role: "host" })).toBeUndefined();
		},
	);

	it("Lifetime object and binding: the store refuses an offer whose object is not predeclared under the recorded root", async () => {
		const fake = fakeWindows();
		const { store, generation } = await launched(fake);
		expect(() =>
			store.offer(generation, "host", JSON.stringify(SUPERVISOR), { status: "presence_unavailable" }),
		).toThrow(expect.objectContaining({ reason: "presence_not_predeclared" }));
	});

	it("Lifetime object and binding: a schema-2 record without presence binding is refused, never read as protected", async () => {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-placement-"));
		roots.push(root);
		const path = join(root, "endpoint.reservation.db");
		await writeFile(path, "", { mode: 0o600 });
		const legacy = new DatabaseSync(path);
		legacy.exec("CREATE TABLE reservations (generation TEXT PRIMARY KEY); PRAGMA user_version = 2;");
		legacy.close();
		await expect(openEndpointReservationStore(path)).rejects.toMatchObject({ reason: "schema_unsupported" });
	});

	it("Lifetime object and binding: startHost predeclares the supervisor's presence object before the spawn", async () => {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-placement-start-"));
		roots.push(root);
		mocked.lockDir = root;
		const socket = join(root, "rpc.sock");
		const agentDir = join(root, "agent");
		await createSocketSecret(socketSecretPath(socket));
		const paths = await createHostDaemonPaths({ agentDir, socket });
		const fake = fakeWindows();
		mocked.placement = fake.load;
		const reachedSpawn = new Error("start reached the supervisor spawn");
		let createdBeforeSpawn = false;
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
		await vi.mocked(childProcess.spawn).withImplementation(
			() => {
				// The reserving owner's own object and the supervisor's.
				createdBeforeSpawn = fake.objects.size === 2;
				throw reachedSpawn;
			},
			async () => {
				await expect(startHost(paths, socket, { agentDir, socket })).rejects.toBe(reachedSpawn);
			},
		);
		expect(createdBeforeSpawn).toBe(true);
		for (const path of fake.objects.keys()) {
			expect(path.startsWith(`\\\\?\\${join(root, "endpoint")}.presence\\`)).toBe(true);
		}
	});

	it("loads the placement natives only on Windows and reports a missing or incomplete bridge as unavailable", () => {
		const requireBinding = vi.fn(() => {
			throw new Error("no prebuild");
		});
		expect(loadPresencePlacement({ platform: "darwin", requireBinding })).toEqual({
			status: "unavailable",
			reason: "unsupported_platform",
		});
		expect(requireBinding).not.toHaveBeenCalled();
		expect(loadPresencePlacement({ platform: "win32", requireBinding })).toEqual({
			status: "unavailable",
			reason: "native_unavailable",
		});
		const { native } = fakeWindows();
		const { presenceObjectCreate: _dropped, ...incomplete } = native;
		expect(loadPresencePlacement({ platform: "win32", requireBinding: () => incomplete })).toEqual({
			status: "unavailable",
			reason: "native_abi_mismatch",
		});
	});
});
