import * as childProcess from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { startHost } from "../../../src/modes/rpc/host-ensure-start.ts";
import {
	credentialCommitment,
	grantVerifiedParticipant,
	parseReservationLocatorArgs,
	reservationStorePath,
	selectLaunchRoute,
	waitForClaim,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { runHostSupervisor } from "../../../src/modes/rpc/host-lifecycle.ts";
import { createSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { fakeWindows } from "../../helpers/fake-windows-presence.ts";

const mocked = vi.hoisted(() => ({
	lockDir: "",
	placement: undefined as unknown,
	events: [] as string[],
	realSpawn: undefined as unknown,
}));

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
	mocked.realSpawn = actual.spawn;
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

const realSpawn = () => mocked.realSpawn as typeof childProcess.spawn;

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199, design section 5 "Mixed versions",
// final paragraph. Protocol contract: before a launcher chooses the new parent-admitted route it obtains an explicit,
// side-effect-free launch-capability result for the selected command (including its wrapper) that names both
// `socket_secret_reservation_v1` and `participant_lifetime_locks_v1`. A recognized legacy or unsupported-capability
// result selects the unchanged legacy route before any reservation-role offer is issued; an execution/IO error is not a
// legacy result; a target that has not reported both capabilities never receives the reservation locator.
const FIXTURE = resolve("test/fixtures/launch-capability-target.mjs");
const PROBE_FLAG = "--launch-capabilities";
const BOTH = ["socket_secret_reservation_v1", "participant_lifetime_locks_v1"];
type TargetBehavior = "both" | "reservation-only" | "legacy" | "malformed" | "fail";
const target = (behavior: TargetBehavior) => ({ command: process.execPath, args: [FIXTURE, behavior] });

/** A real spawn for every launch-capability probe; any other launch records its argv and stops the start right there. */
function spawnUntilLaunch(launched: string[][], stop: Error) {
	vi.mocked(childProcess.spawn).mockImplementation(((command: string, args: readonly string[], options: object) => {
		if (args.includes(PROBE_FLAG)) {
			mocked.events.push("capability probe");
			return realSpawn()(command, args, options);
		}
		mocked.events.push("spawn");
		launched.push([command, ...args]);
		throw stop;
	}) as unknown as typeof childProcess.spawn);
}

describe("#4199 launch capabilities and mixed-version route selection (design section 5, Mixed versions)", () => {
	const roots: string[] = [];
	const stores: EndpointReservationStore[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.mocked(childProcess.spawn).mockImplementation(realSpawn());
		vi.unstubAllGlobals();
		mocked.placement = undefined;
		mocked.events.length = 0;
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function tempRoot() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-capabilities-"));
		roots.push(root);
		return root;
	}

	it.each(["src/cli.ts", "src/cli-main.ts"])(
		"Mixed versions, final paragraph: this build answers the side-effect-free probe through %s with what it implements on this platform (Revision 7 scope: Windows public endpoints only)",
		async (entry) => {
			const agentDir = join(await tempRoot(), "agent");
			const child = childProcess.spawn(
				process.execPath,
				["--import", "tsx", resolve(entry), PROBE_FLAG, "--version"],
				{
					env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			const code = await new Promise<number | null>((accept) => child.once("exit", (exitCode) => accept(exitCode)));
			expect(code).toBe(0);
			// Platform contract: participant lifetime locks are implemented for Windows only; POSIX is the conditional
			// contract with no public secret file, so a POSIX build advertises neither capability.
			expect(JSON.parse(stdout)).toEqual({ launch_capabilities: process.platform === "win32" ? BOTH : [] });
			// Side-effect-free: the probe touched no agent state.
			expect(await readdir(agentDir).catch(() => [])).toEqual([]);
		},
		90_000,
	);

	it.each([
		["a target reporting both capabilities", target("both"), "reservation"],
		[
			"an R5-only target (reservation without lifetime locks) is never labelled fully capable",
			target("reservation-only"),
			"legacy",
		],
		["an old runtime's recognized version answer", target("legacy"), "legacy"],
		[
			"an old wrapper forwarding the probe to a new target (its actual result)",
			{ command: process.execPath, args: [FIXTURE, "wrapper", FIXTURE, "both"] },
			"reservation",
		],
		[
			"an old wrapper forwarding the probe to an old target (its actual result)",
			{ command: process.execPath, args: [FIXTURE, "wrapper", FIXTURE, "legacy"] },
			"legacy",
		],
	] as const)(
		"Mixed versions, final paragraph: the route follows the selected command's explicit result: %s",
		async (_label, launch, route) => {
			await expect(selectLaunchRoute(launch)).resolves.toBe(route);
		},
		30_000,
	);

	it.each([
		["a failing runtime", target("fail")],
		["a malformed capability record", target("malformed")],
		["a command that cannot be started", { command: join(tmpdir(), "rpc4199-no-such-runtime"), args: [] }],
	] as const)(
		"Mixed versions, final paragraph: an execution/IO error is not a legacy result: %s fails closed",
		async (_label, launch) => {
			await expect(selectLaunchRoute(launch)).rejects.toMatchObject({ reason: "launch_capability_unknown" });
		},
		30_000,
	);

	/** A parent-admitted supervisor on this platform (presence_unavailable rows), granted by the test as its issuer. */
	async function admittedSupervisor(
		expectedRoles: readonly ("supervisor" | "host")[],
		child: TargetBehavior | "default",
	) {
		const root = await tempRoot();
		const endpoint = join(root, "public.sock");
		const secret = await createSocketSecret(socketSecretPath(endpoint));
		// The endpoint's fixed store beside its (mocked) ensure lock: the one store the supervisor's locator may name.
		mocked.lockDir = root;
		const store = await openEndpointReservationStore(reservationStorePath(endpoint));
		stores.push(store);
		const issuer = { pid: 1, processStartTime: "issuer" };
		const none = { status: "presence_unavailable" } as const;
		const generation = store.reserve(
			endpoint,
			JSON.stringify(issuer),
			expectedRoles,
			{
				root: { status: "presence_unavailable", reason: "unsupported_platform", detail: null },
				ownerKernelSession: { status: "unverified", reason: "unsupported_platform" },
			},
			none,
		);
		store.offer(generation, "supervisor", JSON.stringify(issuer), none);
		const locator = { storePath: store.path, endpoint, generation, role: "supervisor" as const };
		const launched: string[][] = [];
		const stop = new Error("the supervisor reached its host spawn");
		spawnUntilLaunch(launched, stop);
		const run = runHostSupervisor({
			socket: endpoint,
			agentDir: join(root, "agent"),
			hostArgs: [],
			...(child === "default" ? {} : { childCommand: process.execPath, childArgs: [FIXTURE, child] }),
			reservation: locator,
		}).catch((error: unknown) => error);
		const claim = await waitForClaim(store, generation, "supervisor", { deadlineMs: 20_000 });
		if (!claim.claimed) throw new Error(`the supervisor did not claim: ${claim.reason}`);
		const self = { pid: process.pid, processStartTime: (await readProcessStartTime(process.pid)) ?? null };
		grantVerifiedParticipant(
			store,
			generation,
			"supervisor",
			issuer,
			self,
			credentialCommitment(secret, "supervisor", socketSecretPath(endpoint)),
		);
		return { outcome: await run, stop, launched, store, generation, endpoint };
	}

	it.each([
		["legacy", "launch_capability_missing"],
		["fail", "launch_capability_unknown"],
	] as const)(
		"New desktop + old engine, new wrapper -> old target: a supervisor whose reservation expects a host never hands the locator to a %s explicit child",
		async (child, reason) => {
			const { outcome, launched, store, generation, endpoint } = await admittedSupervisor(
				["supervisor", "host"],
				child,
			);
			expect(outcome).toMatchObject({ reason });
			expect(launched).toEqual([]);
			expect(store.roleRow({ endpoint, generation, role: "host" })).toBeUndefined();
		},
		60_000,
	);

	// The default host is this build: it reports neither capability off Windows (Revision 7 scope), so no locator reaches it.
	it.skipIf(process.platform === "win32")(
		"Mixed versions, final paragraph: a supervisor never hands the locator to its default host where this build reports neither capability",
		async () => {
			const { outcome, launched, store, generation, endpoint } = await admittedSupervisor(
				["supervisor", "host"],
				"default",
			);
			expect(outcome).toMatchObject({ reason: "launch_capability_missing" });
			expect(launched).toEqual([]);
			expect(store.roleRow({ endpoint, generation, role: "host" })).toBeUndefined();
		},
		60_000,
	);

	it("Wrapper-safe launch: a supervisor offers its host role and forwards the locator only to an explicit child that reported both capabilities", async () => {
		const { outcome, stop, launched, store, generation, endpoint } = await admittedSupervisor(
			["supervisor", "host"],
			"both",
		);
		expect(outcome).toBe(stop);
		expect(launched).toHaveLength(1);
		expect(parseReservationLocatorArgs(launched[0] ?? [])).toMatchObject({ generation, role: "host" });
		expect(store.roleRow({ endpoint, generation, role: "host" })?.status).toBe("offered");
	}, 60_000);

	it("New desktop + old engine: a host the reserving owner classified legacy keeps the legacy launch, with no locator flag, no host offer and no claim wait", async () => {
		const { outcome, stop, launched, store, generation, endpoint } = await admittedSupervisor(
			["supervisor"],
			"legacy",
		);
		expect(outcome).toBe(stop);
		expect(launched).toHaveLength(1);
		expect((launched[0] ?? []).some((arg) => arg.startsWith("--reservation-"))).toBe(false);
		expect(mocked.events).toEqual(["spawn"]);
		expect(store.roleRow({ endpoint, generation, role: "host" })).toBeUndefined();
	}, 60_000);

	/** startHost on a Windows public endpoint whose host is an explicit child command; the supervisor spawn stops it. */
	async function startWithChild(child: TargetBehavior) {
		const fake = fakeWindows();
		const root = await tempRoot();
		mocked.lockDir = root;
		mocked.placement = fake.load;
		const socket = join(root, "rpc.sock");
		const agentDir = join(root, "agent");
		await createSocketSecret(socketSecretPath(socket));
		const paths = await createHostDaemonPaths({ agentDir, socket });
		const reserve = EndpointReservationStore.prototype.reserve;
		const reserved: string[] = [];
		vi.spyOn(EndpointReservationStore.prototype, "reserve").mockImplementation(function (
			this: EndpointReservationStore,
			...args
		) {
			mocked.events.push("reserve");
			const generation = reserve.apply(this, args);
			reserved.push(generation);
			return generation;
		});
		const launched: string[][] = [];
		const stop = new Error("start reached the supervisor spawn");
		spawnUntilLaunch(launched, stop);
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
		const hostArgs = ["--child-command", process.execPath, "--child-args", JSON.stringify([FIXTURE, child])];
		const outcome = await startHost(paths, socket, { agentDir, socket, hostArgs }).catch((error: unknown) => error);
		vi.unstubAllGlobals();
		const store = await openEndpointReservationStore(`${join(root, "endpoint")}.reservation.db`);
		stores.push(store);
		return { outcome, stop, reserved, launched, store, fake };
	}

	it.each([
		["both", ["host", "supervisor"]],
		["legacy", ["supervisor"]],
	] as const)(
		"New desktop + old engine: the reserving owner probes an explicit host command (%s) before it reserves and expects the host role only from a capable one",
		async (child, expected) => {
			const { outcome, stop, reserved, launched, store } = await startWithChild(child);
			expect(outcome).toBe(stop);
			expect(mocked.events.slice(0, 1)).toEqual(["capability probe"]);
			expect(reserved).toHaveLength(1);
			expect(store.expectedRoles(reserved[0] ?? "")).toEqual(expected);
			// The supervisor itself is this build: it is launched parent-admitted either way.
			expect(parseReservationLocatorArgs(launched[0] ?? [])).toMatchObject({ role: "supervisor" });
		},
		60_000,
	);

	it("Mixed versions, final paragraph: an unreadable host capability ends the start before any presence lock, credential mutation, reservation or spawn", async () => {
		const { outcome, reserved, launched, fake } = await startWithChild("fail");
		expect(outcome).toMatchObject({ reason: "launch_capability_unknown" });
		expect(mocked.events).toEqual(["capability probe"]);
		expect(reserved).toEqual([]);
		expect(launched).toEqual([]);
		expect(fake.calls.filter((call) => call.startsWith("presenceProbe"))).toEqual([]);
	}, 60_000);
});
