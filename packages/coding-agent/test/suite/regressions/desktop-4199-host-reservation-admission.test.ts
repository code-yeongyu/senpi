import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import {
	credentialCommitment,
	grantVerifiedParticipant,
	reservationStorePath,
	waitForClaim,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import {
	LOCATOR_FLAGS,
	parseReservationLocatorArgs,
	resolveHostChildLaunch,
} from "../../../src/modes/rpc/host-lifecycle-launch.ts";
import { createSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { processIsLive, readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { killAndWait, reapProcessesUnder } from "../../helpers/spawned-host-reaper.ts";

// #4199, design 4.2a step 3/test 6: the real host entry must consume its locator and claim before binding.
// A grant binds the OS-observed identity and public-secret commitment, not the internal hop's credential.
// This real-process probe checks POSIX socket entries; reservation-store tests also cover the platform-neutral protocol.
describe.skipIf(process.platform === "win32")("reserved host admission before listening", () => {
	const roots: string[] = [];
	const children: ChildProcess[] = [];
	const stores: Awaited<ReturnType<typeof openEndpointReservationStore>>[] = [];
	const storeFiles: string[] = [];

	afterEach(async () => {
		for (const root of roots) await reapProcessesUnder(root);
		for (const child of children.splice(0)) await killAndWait(child);
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
		for (const file of storeFiles.splice(0)) await rm(file, { force: true });
	});

	async function offered(role: "host" | "supervisor" = "host") {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-host-"));
		roots.push(root);
		const endpoint = join(root, "public.sock");
		const socket = join(root, "internal.sock");
		const secret = await createSocketSecret(socketSecretPath(endpoint));
		// The claimant is a real process that resolves the endpoint's fixed store itself (design 4.2a step 1), so the
		// store lives where it would in production: beside the endpoint's ensure lock.
		const storePath = reservationStorePath(endpoint);
		await mkdir(dirname(storePath), { recursive: true });
		storeFiles.push(storePath, `${storePath}-journal`);
		const store = await openEndpointReservationStore(storePath);
		stores.push(store);
		const issuer = { pid: process.pid, processStartTime: (await readProcessStartTime(process.pid)) ?? null };
		// POSIX has no presence placement (#4199 Revision 7 scope): the row records presence_unavailable, as startHost's would.
		const generation = store.reserve(
			endpoint,
			JSON.stringify(issuer),
			["supervisor", "host"],
			{
				root: { status: "presence_unavailable", reason: "unsupported_platform", detail: null },
				ownerKernelSession: { status: "unverified", reason: "unsupported_platform" },
			},
			{ status: "presence_unavailable" },
		);
		store.offer(generation, role, JSON.stringify(issuer), { status: "presence_unavailable" });
		const locator = { storePath: store.path, endpoint, generation, role };
		const args = [
			LOCATOR_FLAGS.storePath,
			store.path,
			LOCATOR_FLAGS.endpoint,
			endpoint,
			LOCATOR_FLAGS.generation,
			generation,
			LOCATOR_FLAGS.role,
			role,
		];
		const commitment = credentialCommitment(secret, role, socketSecretPath(endpoint));
		return { root, endpoint, socket, secret, commitment, store, issuer, generation, locator, args };
	}

	async function start() {
		const context = await offered();
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				resolve("src/cli.ts"),
				"--mode",
				"rpc",
				"--multi-session",
				"--listen",
				`unix://${context.socket}`,
				"--no-extensions",
				...context.args,
			],
			{
				env: { ...process.env, SENPI_CODING_AGENT_DIR: context.root, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		children.push(child);
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exit = once(child, "exit", { signal: AbortSignal.timeout(45_000) });
		const claimed = await Promise.race([
			// The host claims only after its CLI has loaded: wait as long as the supervisor does (HOST_STARTUP_BUDGET_MS).
			waitForClaim(context.store, context.generation, "host", { deadlineMs: 30_000 }),
			exit.then(() => {
				throw new Error(`host exited before claiming its reservation: ${stderr}`);
			}),
		]);
		if (!claimed.claimed) throw new Error(`host did not claim: ${claimed.reason}; ${stderr}`);
		return { ...context, child, exit, participant: claimed.participant, stderr: () => stderr };
	}

	/** Resolves once the child's stderr reports its listener, or rejects when it exits first. */
	function listening(child: ChildProcess, exit: Promise<unknown[]>): Promise<void> {
		return new Promise<void>((accept, reject) => {
			let stderr = "";
			child.stderr?.on("data", function onData(chunk: Buffer) {
				stderr += chunk.toString();
				if (!stderr.includes("senpi rpc listening on")) return;
				child.stderr?.off("data", onData);
				accept();
			});
			void exit.then(() => reject(new Error("host exited without listening")));
		});
	}

	it.each([false, true])(
		"forwards the host locator through the child argv (explicit command: %s)",
		async (explicit) => {
			const { endpoint, locator } = await offered();
			const child = resolveHostChildLaunch(
				{
					socket: endpoint,
					hostArgs: [],
					reservation: { ...locator, role: "supervisor" },
					...(explicit ? { childCommand: "wrapper", childArgs: ["entry.js"] } : {}),
				},
				"internal.sock",
				true,
			);
			expect(parseReservationLocatorArgs(child.args)).toEqual(locator);
		},
	);

	it("does not bind until its own OS-verified claim is granted, then commits its pre-listen intent and listens", async () => {
		const context = await start();
		expect(await lstat(context.socket).catch(() => undefined)).toBeUndefined();
		const listened = listening(context.child, context.exit);
		const observed = {
			pid: context.participant.pid,
			processStartTime: (await readProcessStartTime(context.participant.pid)) ?? null,
		};
		grantVerifiedParticipant(context.store, context.generation, "host", context.issuer, observed, context.commitment);
		await listened;
		expect((await lstat(context.socket)).isSocket()).toBe(true);
		// Design 4.2a step 4: the intent is on record across the bind, for the recovery census to read.
		expect(context.store.roleRow(context.locator)).toMatchObject({ status: "granted", listenIntent: true });
	}, 60_000);

	it.each(["cancelled", "wrong commitment", "deadline"] as const)(
		"exits without binding on %s",
		async (failure) => {
			const context = await start();
			if (failure === "cancelled") context.store.cancel(context.generation);
			else if (failure === "wrong commitment")
				grantVerifiedParticipant(
					context.store,
					context.generation,
					"host",
					context.issuer,
					context.participant,
					Buffer.alloc(32),
				);
			const [code] = await context.exit;
			expect(code).not.toBe(0);
			expect(await lstat(context.socket).catch(() => undefined)).toBeUndefined();
		},
		60_000,
	);

	function spawnSupervisor(context: Awaited<ReturnType<typeof offered>>, childArgs: readonly string[]) {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				resolve("src/modes/rpc/host-lifecycle.ts"),
				"--socket",
				context.endpoint,
				"--agent-dir",
				context.root,
				"--no-extensions",
				...context.args,
				...childArgs,
			],
			{
				env: {
					...process.env,
					SENPI_CODING_AGENT_DIR: context.root,
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		children.push(child);
		let stderr = "";
		let acceptReady: () => void = () => {};
		const ready = new Promise<void>((accept) => {
			acceptReady = accept;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.includes("senpi rpc host ready on")) acceptReady();
		});
		const exit = once(child, "exit", { signal: AbortSignal.timeout(45_000) });
		return { child, ready, exit, stderr: () => stderr };
	}

	/** Waits for the supervisor's own claim, verifies it through the OS and grants it as the launcher would. */
	async function grantSupervisor(
		context: Awaited<ReturnType<typeof offered>>,
		supervisor: ReturnType<typeof spawnSupervisor>,
	) {
		const claim = await Promise.race([
			waitForClaim(context.store, context.generation, "supervisor", { deadlineMs: 20_000 }),
			supervisor.exit.then(() => {
				throw new Error(`supervisor exited before claiming: ${supervisor.stderr()}`);
			}),
		]);
		if (!claim.claimed) throw new Error(`supervisor did not claim: ${supervisor.stderr()}`);
		const observed = {
			pid: claim.participant.pid,
			processStartTime: (await readProcessStartTime(claim.participant.pid)) ?? null,
		};
		grantVerifiedParticipant(
			context.store,
			context.generation,
			"supervisor",
			context.issuer,
			observed,
			context.commitment,
		);
		return observed;
	}

	it.each([true, false])(
		"the supervisor grants its host or stops an unclaimed child (claims: %s)",
		async (claims) => {
			const context = await offered("supervisor");
			const childArgs = claims
				? []
				: [
						"--child-command",
						process.execPath,
						"--child-args",
						JSON.stringify([
							"-e",
							'console.error("unclaimed-host-pid=" + process.pid); setInterval(() => {}, 1000)',
							"--",
						]),
					];
			const supervisor = spawnSupervisor(context, childArgs);
			const observed = await grantSupervisor(context, supervisor);
			if (claims) {
				await Promise.race([
					supervisor.ready,
					supervisor.exit.then(() => {
						throw new Error(`supervisor failed: ${supervisor.stderr()}`);
					}),
				]);
				const host = context.store.roleRow({ ...context.locator, role: "host" });
				expect(host?.status).toBe("granted");
				expect(host?.issuer).toBe(JSON.stringify(observed));
				const participant = JSON.parse(host?.participant ?? "{}") as { pid: number; processStartTime: string };
				expect(participant.pid).not.toBe(supervisor.child.pid);
				expect(await readProcessStartTime(participant.pid)).toBe(participant.processStartTime);
				// Both participants committed their pre-listen intent before binding (design 4.2a step 4).
				expect(host?.listenIntent).toBe(true);
				expect(context.store.roleRow(context.locator)?.listenIntent).toBe(true);
				context.store.markServing(context.generation);
				expect(context.store.reservation(context.generation).state).toBe("serving");
			} else {
				const [code] = await supervisor.exit;
				expect(code).not.toBe(0);
				expect(supervisor.stderr()).toContain("claim_deadline");
				const pid = Number(/unclaimed-host-pid=(\d+)/.exec(supervisor.stderr())?.[1]);
				expect(pid).toBeGreaterThan(0);
				expect(processIsLive(pid)).toBe(false);
				expect(await lstat(context.endpoint).catch(() => undefined)).toBeUndefined();
				// A failed start fences the generation it offered the host in ("Crash, cancellation and commit").
				expect(context.store.reservation(context.generation).state).toBe("cancelling");
				expect(context.store.roleRow({ ...context.locator, role: "host" })?.status).toBe("revoked");
			}
		},
		60_000,
	);

	// Design 4.2a step 4 and "Crash, cancellation and commit": a cancellation fenced after the host grant is seen by a
	// pre-listen intent transaction before any public bind. The cancel is committed the moment the grant row appears;
	// the supervisor commits its own intent only after its host committed one, bound its private hop and answered the
	// internal readiness probe, so the cancel precedes that intent and the supervisor's start fails unbound.
	it("a cancellation after the host grant leaves the public endpoint unbound", async () => {
		const context = await offered("supervisor");
		const supervisor = spawnSupervisor(context, []);
		await grantSupervisor(context, supervisor);
		const hostLocator = { ...context.locator, role: "host" as const };
		await Promise.race([
			(async () => {
				for (;;) {
					if (context.store.roleRow(hostLocator)?.status === "granted") return;
					await new Promise((tick) => setTimeout(tick, 5));
				}
			})(),
			supervisor.exit.then(() => {
				throw new Error(`supervisor exited before granting its host: ${supervisor.stderr()}`);
			}),
			supervisor.ready.then(() => {
				throw new Error("the supervisor was ready before its host was granted");
			}),
		]);
		context.store.cancel(context.generation);
		expect(context.store.roleRow(context.locator)?.listenIntent).toBe(false);
		const [code] = await Promise.race([
			supervisor.exit,
			supervisor.ready.then(() => {
				throw new Error("the supervisor was ready although its generation was cancelled after the host grant");
			}),
		]);
		expect(code).not.toBe(0);
		expect(supervisor.stderr()).toContain("generation_cancelled");
		expect(await lstat(context.endpoint).catch(() => undefined)).toBeUndefined();
		const participant = JSON.parse(context.store.roleRow(hostLocator)?.participant ?? "{}") as { pid: number };
		expect(participant.pid).toBeGreaterThan(0);
		expect(processIsLive(participant.pid)).toBe(false);
	}, 60_000);
});
