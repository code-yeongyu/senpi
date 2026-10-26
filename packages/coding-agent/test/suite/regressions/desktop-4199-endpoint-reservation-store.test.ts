import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENDPOINT_RESERVATION_SCHEMA,
	EndpointReservationError,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Reservation through
// startup" and "Wrapper-safe discovery and one-time claim", test 10). Security contract: a role's one-time nonce is
// consumed by exactly one participant through a compare-and-set on endpoint, generation, role, nonce and state; replays,
// copied locators, wrong roles or endpoints, old or cancelled generations and unsupported schemas never claim; a grant
// binds only the recorded participant and a well-formed credential commitment; cancellation revokes offers but keeps
// every claimed identity.
const OWNER = '{"pid":100,"creationTime":"133000000000000001","userSid":"S-1-5-21-1"}';
const SUPERVISOR = '{"pid":200,"creationTime":"133000000000000002","userSid":"S-1-5-21-1"}';
const INTRUDER = '{"pid":201,"creationTime":"133000000000000003","userSid":"S-1-5-21-1"}';
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const COMMITMENT = createHash("sha256").update(randomBytes(32)).digest();

describe("endpoint reservation store", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function store() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-reservation-"));
		roots.push(root);
		const path = join(root, "endpoint.reservation.db");
		return { path, store: await openEndpointReservationStore(path) };
	}

	async function offered() {
		const opened = await store();
		const generation = opened.store.reserve(ENDPOINT, OWNER, ["supervisor", "host"]);
		opened.store.offer(generation, "supervisor", OWNER);
		const locator = { endpoint: ENDPOINT, generation, role: "supervisor" as const };
		return { ...opened, generation, locator, nonce: opened.store.readOffer(locator) };
	}

	function rejection(run: () => unknown): string {
		try {
			run();
		} catch (error) {
			if (error instanceof EndpointReservationError) return error.reason;
			throw error;
		}
		throw new Error("expected a rejection");
	}

	it("creates the database owner-only and refuses a group-readable or symlinked one", async () => {
		const { path } = await store();
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
		await chmod(path, 0o640);
		await expect(openEndpointReservationStore(path)).rejects.toThrow(EndpointReservationError);
		const root = await mkdtemp(join(tmpdir(), "rpc4199-reservation-"));
		roots.push(root);
		await writeFile(join(root, "elsewhere.db"), "", { mode: 0o600 });
		await symlink(join(root, "elsewhere.db"), join(root, "link.db"));
		await expect(openEndpointReservationStore(join(root, "link.db"))).rejects.toThrow(EndpointReservationError);
	});

	it("gives every role offer a fresh 256-bit nonce that is never the generation", async () => {
		const { store: s, generation, nonce } = await offered();
		expect(nonce).toHaveLength(32);
		s.offer(generation, "host", SUPERVISOR);
		const host = s.readOffer({ endpoint: ENDPOINT, generation, role: "host" });
		expect(host).toHaveLength(32);
		expect(host.equals(nonce)).toBe(false);
		expect(nonce.toString("hex")).not.toContain(generation);
	});

	it("lets exactly one of two racing descendants claim a role", async () => {
		const { path, store: s, locator, nonce } = await offered();
		const other = await openEndpointReservationStore(path);
		const otherNonce = other.readOffer(locator);
		expect(s.claim(locator, nonce, SUPERVISOR)).toBe("claimed");
		expect(rejection(() => other.claim(locator, otherNonce, INTRUDER))).toBe("role_already_claimed");
		other.close();
		expect(s.roleRow(locator)).toMatchObject({ status: "claimed", participant: SUPERVISOR });
	});

	it("answers a retry of the same participant without consuming anything new", async () => {
		const { store: s, locator, nonce } = await offered();
		s.claim(locator, nonce, SUPERVISOR);
		expect(s.claim(locator, nonce, SUPERVISOR)).toBe("already_claimed_by_caller");
	});

	it.each([
		["a wrong nonce", (l: Locator, n: Buffer) => ({ locator: l, nonce: randomBytes(n.length) }), "nonce_mismatch"],
		["no nonce", (l: Locator) => ({ locator: l, nonce: Buffer.alloc(0) }), "nonce_mismatch"],
		[
			"the wrong role",
			(l: Locator, n: Buffer) => ({ locator: { ...l, role: "host" as const }, nonce: n }),
			"role_not_offered",
		],
		[
			"another endpoint",
			(l: Locator, n: Buffer) => ({ locator: { ...l, endpoint: `${ENDPOINT}2` }, nonce: n }),
			"endpoint_mismatch",
		],
		[
			"an unknown generation",
			(l: Locator, n: Buffer) => ({ locator: { ...l, generation: "0".repeat(32) }, nonce: n }),
			"generation_unknown",
		],
	])("rejects a claim with %s", async (_label, tamper, reason) => {
		const { store: s, locator, nonce } = await offered();
		const attempt = tamper(locator, nonce);
		expect(rejection(() => s.claim(attempt.locator, attempt.nonce, INTRUDER))).toBe(reason);
		expect(s.roleRow(locator)).toMatchObject({ status: "offered", participant: null });
	});

	it("revokes outstanding offers on cancellation and keeps claimed identities", async () => {
		const { store: s, generation, locator, nonce } = await offered();
		s.offer(generation, "host", SUPERVISOR);
		const hostLocator = { endpoint: ENDPOINT, generation, role: "host" as const };
		const hostNonce = s.readOffer(hostLocator);
		s.claim(locator, nonce, SUPERVISOR);
		s.cancel(generation);
		expect(s.reservation(generation)).toMatchObject({ state: "cancelling" });
		expect(rejection(() => s.claim(hostLocator, hostNonce, INTRUDER))).toBe("generation_cancelled");
		expect(rejection(() => s.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT))).toBe(
			"generation_cancelled",
		);
		expect(s.roleRow(locator)).toMatchObject({ status: "claimed", participant: SUPERVISOR });
		expect(s.roleRow(hostLocator)).toMatchObject({ status: "revoked", participant: null });
	});

	it("grants only the recorded participant, from the recorded issuer, with a SHA-256 commitment", async () => {
		const { store: s, generation, locator, nonce } = await offered();
		s.claim(locator, nonce, SUPERVISOR);
		expect(rejection(() => s.grant(generation, "supervisor", OWNER, INTRUDER, COMMITMENT))).toBe(
			"participant_mismatch",
		);
		expect(rejection(() => s.grant(generation, "supervisor", SUPERVISOR, SUPERVISOR, COMMITMENT))).toBe(
			"issuer_mismatch",
		);
		expect(rejection(() => s.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT.subarray(0, 31)))).toBe(
			"commitment_invalid",
		);
		s.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT);
		expect(s.roleRow(locator)).toMatchObject({ status: "granted", participant: SUPERVISOR });
	});

	it("refuses to grant an offered role that nobody claimed", async () => {
		const { store: s, generation } = await offered();
		expect(rejection(() => s.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT))).toBe(
			"role_not_claimed",
		);
	});

	it("commits serving only after every offered role is granted", async () => {
		const { store: s, generation, locator, nonce } = await offered();
		s.offer(generation, "host", SUPERVISOR);
		s.claim(locator, nonce, SUPERVISOR);
		s.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT);
		expect(rejection(() => s.markServing(generation))).toBe("roles_not_granted");
		const hostLocator = { endpoint: ENDPOINT, generation, role: "host" as const };
		s.claim(hostLocator, s.readOffer(hostLocator), INTRUDER);
		s.grant(generation, "host", SUPERVISOR, INTRUDER, COMMITMENT);
		s.markServing(generation);
		expect(s.reservation(generation)).toMatchObject({ state: "serving" });
	});

	it("refuses serving while the host role was never offered, even with the supervisor granted", async () => {
		const { store: s, generation, locator, nonce } = await offered();
		s.claim(locator, nonce, SUPERVISOR);
		s.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT);
		expect(rejection(() => s.markServing(generation))).toBe("roles_not_granted");
		expect(s.reservation(generation)).not.toMatchObject({ state: "serving" });
	});

	// Design 4.2a: the record names its expected roles; serving needs exactly those granted. A self-reserving direct
	// supervisor or standalone public host expects only the role of the child it admits.
	it("commits serving for a generation that expects only the host role once the host is granted", async () => {
		const { store: s } = await store();
		const generation = s.reserve(ENDPOINT, OWNER, ["host"]);
		s.offer(generation, "host", OWNER);
		const hostLocator = { endpoint: ENDPOINT, generation, role: "host" as const };
		s.claim(hostLocator, s.readOffer(hostLocator), SUPERVISOR);
		s.grant(generation, "host", OWNER, SUPERVISOR, COMMITMENT);
		s.markServing(generation);
		expect(s.reservation(generation)).toMatchObject({ state: "serving" });
	});

	it("refuses to offer a role the generation does not expect", async () => {
		const { store: s } = await store();
		const generation = s.reserve(ENDPOINT, OWNER, ["host"]);
		expect(rejection(() => s.offer(generation, "supervisor", OWNER))).toBe("role_not_expected");
	});

	it("bumps the revision on every transition", async () => {
		const { store: s, generation, locator, nonce } = await offered();
		const before = s.reservation(generation).revision;
		s.claim(locator, nonce, SUPERVISOR);
		expect(s.reservation(generation).revision).toBe(before + 1);
	});

	it("rejects a store written by an unsupported schema", async () => {
		const { path, store: s } = await store();
		s.close();
		const raw = new DatabaseSync(path);
		raw.exec(`PRAGMA user_version = ${ENDPOINT_RESERVATION_SCHEMA + 1}`);
		raw.close();
		await expect(openEndpointReservationStore(path)).rejects.toMatchObject({ reason: "schema_unsupported" });
	});
	it.each(["reservation", "roleRow", "readOffer"] as const)(
		"answers %s blocked by an exclusive writer as store_busy",
		async (method) => {
			const { path, store: s, generation, locator } = await offered();
			const writer = new DatabaseSync(path);
			try {
				writer.exec("BEGIN EXCLUSIVE; UPDATE reservations SET revision = revision + 1;");
				expect(rejection(() => (method === "reservation" ? s.reservation(generation) : s[method](locator)))).toBe(
					"store_busy",
				);
			} finally {
				writer.exec("ROLLBACK;");
				writer.close();
				s.close();
			}
		},
	);

	it("answers a commit blocked by another connection's read as store_busy and writes nothing", async () => {
		const { path, store: s } = await store();
		const generation = s.reserve(ENDPOINT, OWNER, ["supervisor", "host"]);
		const reader = new DatabaseSync(path);
		reader.exec("BEGIN; SELECT * FROM roles;");
		expect(rejection(() => s.offer(generation, "supervisor", OWNER))).toBe("store_busy");
		reader.exec("COMMIT;");
		reader.close();
		expect(s.roleRow({ endpoint: ENDPOINT, generation, role: "supervisor" })).toBeUndefined();
	});
});

type Locator = { endpoint: string; generation: string; role: "supervisor" | "host" };
