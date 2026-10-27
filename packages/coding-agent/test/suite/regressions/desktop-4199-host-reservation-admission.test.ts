import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { grantVerifiedParticipant, waitForClaim } from "../../../src/modes/rpc/host-launch-reservation.ts";
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

	afterEach(async () => {
		for (const root of roots) await reapProcessesUnder(root);
		for (const child of children.splice(0)) await killAndWait(child);
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function offered(role: "host" | "supervisor" = "host") {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-host-"));
		roots.push(root);
		const endpoint = join(root, "public.sock");
		const socket = join(root, "internal.sock");
		const secret = await createSocketSecret(socketSecretPath(endpoint));
		const store = await openEndpointReservationStore(join(root, "reservation.db"));
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
		return { root, endpoint, socket, secret, store, issuer, generation, locator, args };
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
		return { ...context, child, exit, participant: claimed.participant };
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

	it("does not bind until its own OS-verified claim is granted, then listens", async () => {
		const context = await start();
		expect(await lstat(context.socket).catch(() => undefined)).toBeUndefined();
		const listening = new Promise<void>((accept, reject) => {
			const timer = setTimeout(() => reject(new Error("host did not listen")), 30_000);
			let stderr = "";
			context.child.stderr?.on("data", function onData(chunk: Buffer) {
				stderr += chunk.toString();
				if (!stderr.includes("senpi rpc listening on")) return;
				clearTimeout(timer);
				context.child.stderr?.off("data", onData);
				accept();
			});
		});
		const observed = {
			pid: context.participant.pid,
			processStartTime: (await readProcessStartTime(context.participant.pid)) ?? null,
		};
		grantVerifiedParticipant(
			context.store,
			context.generation,
			"host",
			context.issuer,
			observed,
			createHash("sha256").update(context.secret).digest(),
		);
		await listening;
		expect((await lstat(context.socket)).isSocket()).toBe(true);
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
			const claim = await Promise.race([
				waitForClaim(context.store, context.generation, "supervisor", { deadlineMs: 20_000 }),
				exit.then(() => {
					throw new Error(`supervisor exited before claiming: ${stderr}`);
				}),
			]);
			if (!claim.claimed) throw new Error(`supervisor did not claim: ${stderr}`);
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
				createHash("sha256").update(context.secret).digest(),
			);
			if (claims) {
				await Promise.race([
					ready,
					exit.then(() => {
						throw new Error(`supervisor failed: ${stderr}`);
					}),
				]);
				const host = context.store.roleRow({ ...context.locator, role: "host" });
				expect(host?.status).toBe("granted");
				expect(host?.issuer).toBe(JSON.stringify(observed));
				const participant = JSON.parse(host?.participant ?? "{}") as { pid: number; processStartTime: string };
				expect(participant.pid).not.toBe(child.pid);
				expect(await readProcessStartTime(participant.pid)).toBe(participant.processStartTime);
				context.store.markServing(context.generation);
				expect(context.store.reservation(context.generation).state).toBe("serving");
			} else {
				const [code] = await exit;
				expect(code).not.toBe(0);
				expect(stderr).toContain("claim_deadline");
				const pid = Number(/unclaimed-host-pid=(\d+)/.exec(stderr)?.[1]);
				expect(pid).toBeGreaterThan(0);
				expect(processIsLive(pid)).toBe(false);
				expect(await lstat(context.endpoint).catch(() => undefined)).toBeUndefined();
			}
		},
		60_000,
	);
});
