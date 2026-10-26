import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { parseSupervisorArgs } from "../../../src/modes/rpc/host-lifecycle-launch.ts";
import {
	admitClaimedSupervisor,
	grantVerifiedParticipant,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	waitForClaim,
} from "../../../src/modes/rpc/host-launch-reservation.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Wrapper-safe
// discovery and one-time claim" steps 2 and 4, test 6). Security contract: a supervisor launched with a reservation
// locator claims its role and starts only once granted, after verifying the parent's established secret read-only
// against the granted commitment; it never provisions or repairs, and never falls back to a direct launch. The locator
// never reaches the host child's arguments.
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const OWNER = { pid: 100, processStartTime: "133000000000000001" };
const SELF = { pid: 200, processStartTime: "133000000000000002" };
const SECRET = randomBytes(32);
const COMMITMENT = createHash("sha256").update(SECRET).digest();

function locatorOf(args: readonly string[]) {
	const locator = parseReservationLocatorArgs(args);
	if (locator === undefined) throw new Error("the launch args carry no reservation locator");
	return locator;
}

describe("supervisor admission through a reservation", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function offered() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-supervisor-"));
		roots.push(root);
		const store = await openEndpointReservationStore(join(root, "endpoint.reservation.db"));
		const { generation, args } = offerSupervisorLaunch(store, ENDPOINT, OWNER);
		return { store, generation, args, locator: locatorOf(args) };
	}

	it("keeps the locator out of the host child's arguments", async () => {
		const { args, locator } = await offered();
		const launch = parseSupervisorArgs(["--socket", ENDPOINT, ...args, "--no-extensions"]);
		expect(launch?.reservation).toEqual(locator);
		expect(launch?.hostArgs).toEqual(["--no-extensions"]);
	});

	it("starts once granted and the established secret matches the commitment", async () => {
		const { store, generation, locator } = await offered();
		const admitted = admitClaimedSupervisor(locator, SELF, SECRET, { deadlineMs: 5_000 });
		const claim = await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		expect(claim).toEqual({ claimed: true, participant: SELF });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, COMMITMENT);
		await expect(admitted).resolves.toBeUndefined();
	});

	it("refuses to start when the established secret differs from the granted commitment", async () => {
		const { store, generation, locator } = await offered();
		const admitted = admitClaimedSupervisor(locator, SELF, randomBytes(32), { deadlineMs: 5_000 });
		await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, COMMITMENT);
		await expect(admitted).rejects.toMatchObject({ reason: "commitment_mismatch" });
	});

	it("refuses to start with no established secret instead of provisioning one", async () => {
		const { store, generation, locator } = await offered();
		const admitted = admitClaimedSupervisor(locator, SELF, undefined, { deadlineMs: 5_000 });
		await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, COMMITMENT);
		await expect(admitted).rejects.toMatchObject({ reason: "commitment_mismatch" });
	});

	it("refuses to start when no grant arrives, and when the generation is cancelled", async () => {
		const first = await offered();
		await expect(admitClaimedSupervisor(first.locator, SELF, SECRET, { deadlineMs: 0 })).rejects.toMatchObject({
			reason: "grant_deadline",
		});
		const second = await offered();
		second.store.cancel(second.generation);
		await expect(admitClaimedSupervisor(second.locator, SELF, SECRET, { deadlineMs: 5_000 })).rejects.toMatchObject({
			reason: "generation_cancelled",
		});
	});
});
