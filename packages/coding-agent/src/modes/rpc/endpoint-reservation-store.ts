/**
 * The endpoint reservation store of sisyphuslabs/omo-desktop-app#4199 (design 4.2a "Reservation through startup",
 * "Wrapper-safe discovery and one-time claim", "Crash, cancellation and commit"): a private SQLite database beside the
 * endpoint lock, `<endpoint-lock-target>.reservation.db`, with one short `BEGIN IMMEDIATE` transaction per transition.
 *
 * Only an endpoint-lock holder reserves or retires a generation; verified participants claim their role with a one-time
 * 256-bit nonce through a compare-and-set on endpoint, generation, role, nonce and state. The store holds nonces and so
 * is credential-bearing; it never holds the public secret, only a SHA-256 commitment to it. Rows are never deleted:
 * cancellation is a durable `cancelling` state that revokes offers and keeps every claimed identity.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export const ENDPOINT_RESERVATION_SCHEMA = 2;

export type ReservationRole = "supervisor" | "host";
export type ReservationState = "pending" | "cancelling" | "serving";
export type RoleStatus = "offered" | "claimed" | "granted" | "released" | "revoked";

export type ReservationRejection =
	| "store_insecure"
	| "store_busy"
	| "schema_unsupported"
	| "generation_unknown"
	| "generation_cancelled"
	| "generation_not_pending"
	| "endpoint_mismatch"
	| "role_not_offered"
	| "role_already_offered"
	| "role_not_expected"
	| "role_already_claimed"
	| "role_not_claimed"
	| "role_not_granted"
	| "nonce_mismatch"
	| "participant_mismatch"
	| "issuer_mismatch"
	| "commitment_invalid"
	| "roles_not_granted";

/** A typed refusal; `reason` is machine-readable and the message never carries a nonce. */
export class EndpointReservationError extends Error {
	readonly code = "endpoint-reservation-rejected";
	readonly reason: ReservationRejection;

	constructor(reason: ReservationRejection, detail: string) {
		super(`endpoint reservation ${reason}: ${detail}`);
		this.name = "EndpointReservationError";
		this.reason = reason;
	}
}

/** What a wrapper may forward: no nonce, no credential. */
export interface ReservationLocator {
	readonly endpoint: string;
	readonly generation: string;
	readonly role: ReservationRole;
}

export interface ReservationRow {
	readonly endpoint: string;
	readonly generation: string;
	readonly state: ReservationState;
	readonly revision: number;
	readonly owner: string;
}

export interface RoleRow {
	readonly role: ReservationRole;
	readonly status: RoleStatus;
	readonly issuer: string;
	readonly participant: string | null;
}

interface Statement {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

interface Database {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
}

/** bun:sqlite inside the Bun binary, node:sqlite under Node; the same loading boundary as ownership-safe-lock.ts. */
async function openDatabase(path: string): Promise<Database> {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const database = new Database(path);
		return {
			exec: (sql) => database.exec(sql),
			prepare: (sql) => database.prepare(sql) as unknown as Statement,
			close: () => database.close(false),
		};
	}
	const { DatabaseSync } = await import("node:sqlite");
	const database = new DatabaseSync(path);
	return {
		exec: (sql) => database.exec(sql),
		prepare: (sql) => database.prepare(sql) as unknown as Statement,
		close: () => database.close(),
	};
}

/**
 * Creates the database file owner-only when absent and validates an existing one through a no-follow descriptor before
 * SQLite opens it: a regular file, owned by this user, with no group or other permission bits (POSIX). Windows DACL
 * validation belongs to the native bridge and is not done here.
 */
async function precreatePrivate(path: string): Promise<{ dev: number; ino: number }> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
	} catch (error: unknown) {
		throw new EndpointReservationError("store_insecure", `cannot open ${path}: ${(error as Error).message}`);
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new EndpointReservationError("store_insecure", `not a regular file: ${path}`);
		if (process.platform !== "win32") {
			if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
				throw new EndpointReservationError("store_insecure", `owned by another user: ${path}`);
			}
			if ((info.mode & 0o077) !== 0) {
				throw new EndpointReservationError("store_insecure", `readable or writable by others: ${path}`);
			}
		}
		return { dev: info.dev, ino: info.ino };
	} finally {
		await handle.close();
	}
}

/**
 * SQLite contention: the primary result code SQLITE_BUSY (5) or SQLITE_LOCKED (6), read from node:sqlite's `errcode`
 * or a runtime's `SQLITE_BUSY*`/`SQLITE_LOCKED*` code; the message is consulted only when the error carries neither.
 */
function isBusy(error: unknown): boolean {
	const errcode = typeof error === "object" && error !== null ? Reflect.get(error, "errcode") : undefined;
	if (typeof errcode === "number") return (errcode & 0xff) === 5 || (errcode & 0xff) === 6;
	const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
	if (typeof code === "string" && code.startsWith("SQLITE_")) return /^SQLITE_(BUSY|LOCKED)/.test(code);
	return /database is (locked|busy)|database table is locked/i.test(
		error instanceof Error ? error.message : String(error),
	);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reservations (
	generation TEXT PRIMARY KEY,
	endpoint TEXT NOT NULL,
	state TEXT NOT NULL,
	revision INTEGER NOT NULL,
	owner TEXT NOT NULL,
	expected_roles TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
	generation TEXT NOT NULL REFERENCES reservations(generation),
	role TEXT NOT NULL,
	nonce TEXT,
	issuer TEXT NOT NULL,
	status TEXT NOT NULL,
	participant TEXT,
	commitment TEXT,
	PRIMARY KEY (generation, role)
);`;

export async function openEndpointReservationStore(path: string): Promise<EndpointReservationStore> {
	const validated = await precreatePrivate(path);
	const database = await openDatabase(path);
	try {
		// SQLite reopens the path by name; the file it opened must still be the one validated above.
		const opened = await lstat(path);
		if (!opened.isFile() || opened.dev !== validated.dev || opened.ino !== validated.ino) {
			throw new EndpointReservationError("store_insecure", `replaced while opening: ${path}`);
		}
		database.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 100;");
		const version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		if (version === 0) {
			database.exec(`BEGIN IMMEDIATE; ${SCHEMA_SQL} PRAGMA user_version = ${ENDPOINT_RESERVATION_SCHEMA}; COMMIT;`);
		} else if (version !== ENDPOINT_RESERVATION_SCHEMA) {
			throw new EndpointReservationError("schema_unsupported", `schema ${version} in ${path}`);
		}
	} catch (error: unknown) {
		database.close();
		// The open-time pragmas and the schema read take SQLite locks too: another writer is store_busy, never a raw error.
		if (!(error instanceof EndpointReservationError) && isBusy(error)) {
			throw new EndpointReservationError("store_busy", "another process holds the reservation store");
		}
		throw error;
	}
	return new EndpointReservationStore(database);
}

export class EndpointReservationStore {
	readonly #database: Database;

	constructor(database: Database) {
		this.#database = database;
	}

	close(): void {
		this.#database.close();
	}

	/**
	 * Creates a pending generation that expects exactly `expectedRoles` (design 4.2a, the minimum record). The ensure path,
	 * which admits a supervisor that admits a host, expects both; a self-reserving direct supervisor expects only its host
	 * child; a standalone public host, reserving itself with no child hop, expects (and self-offers) only "host". Unknown
	 * or absent roles are refused. The caller holds the endpoint lock.
	 */
	reserve(endpoint: string, owner: string, expectedRoles: readonly ReservationRole[]): string {
		const roles = [...new Set(expectedRoles)].sort();
		if (roles.length === 0) throw new EndpointReservationError("role_not_expected", "a reservation expects no role");
		const unknown = roles.filter((role) => role !== "supervisor" && role !== "host");
		if (unknown.length > 0)
			throw new EndpointReservationError("role_not_expected", `unknown role ${unknown.join(",")}`);
		const generation = randomBytes(16).toString("hex");
		this.#transaction(() => {
			this.#database
				.prepare(
					"INSERT INTO reservations (generation, endpoint, state, revision, owner, expected_roles) VALUES (?, ?, 'pending', 1, ?, ?)",
				)
				.run(generation, endpoint, owner, roles.join(","));
		});
		return generation;
	}

	/** Offers `role` with a fresh nonce, issued by `issuer`, before the launcher spawns it. */
	offer(generation: string, role: ReservationRole, issuer: string): void {
		this.#transaction(() => {
			this.#pending(generation);
			if (!this.#expectedRoles(generation)?.includes(role)) {
				throw new EndpointReservationError("role_not_expected", `${role} in ${generation}`);
			}
			if (this.#role(generation, role)) {
				throw new EndpointReservationError("role_already_offered", `${role} in ${generation}`);
			}
			this.#database
				.prepare("INSERT INTO roles (generation, role, nonce, issuer, status) VALUES (?, ?, ?, ?, 'offered')")
				.run(generation, role, randomBytes(32).toString("hex"), issuer);
			this.#bump(generation);
		});
	}

	/** The claimant reads its role's nonce from the store itself, never from a wrapper or an inherited channel. */
	readOffer(locator: ReservationLocator): Buffer {
		const reservation = this.#locate(locator);
		if (reservation.state === "cancelling") {
			throw new EndpointReservationError("generation_cancelled", locator.generation);
		}
		const row = this.#role(locator.generation, locator.role);
		if (!row || row.status !== "offered" || row.nonce === null) {
			throw new EndpointReservationError("role_not_offered", `${locator.role} in ${locator.generation}`);
		}
		return Buffer.from(row.nonce, "hex");
	}

	/**
	 * Consumes the role's nonce once, recording `participant`. A retry by the participant already recorded answers
	 * `already_claimed_by_caller` without a nonce; that is safe only because callers pass an identity they read from the
	 * OS for themselves (PID and exact start time), never one taken from another process. Anyone else is refused.
	 */
	claim(locator: ReservationLocator, nonce: Uint8Array, participant: string): "claimed" | "already_claimed_by_caller" {
		return this.#transaction(() => {
			const reservation = this.#locate(locator);
			if (reservation.state === "cancelling") {
				throw new EndpointReservationError("generation_cancelled", locator.generation);
			}
			if (reservation.state !== "pending") {
				throw new EndpointReservationError("generation_not_pending", locator.generation);
			}
			const row = this.#role(locator.generation, locator.role);
			if (!row || row.status === "revoked") {
				throw new EndpointReservationError("role_not_offered", `${locator.role} in ${locator.generation}`);
			}
			if (row.status !== "offered") {
				if (row.participant === participant) return "already_claimed_by_caller";
				throw new EndpointReservationError("role_already_claimed", `${locator.role} in ${locator.generation}`);
			}
			const expected = Buffer.from(row.nonce ?? "", "hex");
			if (expected.length !== 32 || nonce.length !== 32 || !timingSafeEqual(expected, nonce)) {
				throw new EndpointReservationError("nonce_mismatch", `${locator.role} in ${locator.generation}`);
			}
			// The compare-and-set itself: only the row still offered with this exact nonce changes.
			const changed = this.#database
				.prepare(
					"UPDATE roles SET status = 'claimed', nonce = NULL, participant = ? WHERE generation = ? AND role = ? AND status = 'offered' AND nonce = ?",
				)
				.run(participant, locator.generation, locator.role, expected.toString("hex")) as {
				changes: number | bigint;
			};
			if (Number(changed.changes) !== 1) {
				throw new EndpointReservationError("role_already_claimed", `${locator.role} in ${locator.generation}`);
			}
			this.#bump(locator.generation);
			return "claimed";
		});
	}

	/** The issuer grants the recorded participant, bound to the SHA-256 commitment of the credential it established. */
	grant(generation: string, role: ReservationRole, issuer: string, participant: string, commitment: Uint8Array): void {
		this.#transaction(() => {
			this.#pending(generation);
			const row = this.#role(generation, role);
			if (!row || row.status !== "claimed") {
				throw new EndpointReservationError("role_not_claimed", `${role} in ${generation}`);
			}
			if (row.issuer !== issuer) throw new EndpointReservationError("issuer_mismatch", `${role} in ${generation}`);
			if (row.participant !== participant) {
				throw new EndpointReservationError("participant_mismatch", `${role} in ${generation}`);
			}
			if (commitment.length !== 32) {
				throw new EndpointReservationError("commitment_invalid", `${role} in ${generation}`);
			}
			this.#database
				.prepare("UPDATE roles SET status = 'granted', commitment = ? WHERE generation = ? AND role = ?")
				.run(Buffer.from(commitment).toString("hex"), generation, role);
			this.#bump(generation);
		});
	}

	/**
	 * The durable cancellation fence: revokes every outstanding offer and keeps claimed and granted identities. It also
	 * fences a `serving` generation, which recovery does to an abandoned generation before its retirement census.
	 */
	cancel(generation: string): void {
		this.#transaction(() => {
			this.#reservation(generation);
			this.#database
				.prepare("UPDATE roles SET status = 'revoked', nonce = NULL WHERE generation = ? AND status = 'offered'")
				.run(generation);
			this.#database.prepare("UPDATE reservations SET state = 'cancelling' WHERE generation = ?").run(generation);
			this.#bump(generation);
		});
	}

	/** Commits `serving` only when the generation's expected roles are known and non-empty, each is granted, and every offered row is granted. */
	markServing(generation: string): void {
		this.#transaction(() => {
			this.#pending(generation);
			const rows = this.#database.prepare("SELECT role, status FROM roles WHERE generation = ?").all(generation) as {
				role: ReservationRole;
				status: RoleStatus;
			}[];
			// Serving needs every EXPECTED role granted: a generation whose expected host was never offered has no admitted
			// listener, while a self-reserving launcher that expects only its child's role commits once that one is granted.
			const granted = new Set(rows.filter(({ status }) => status === "granted").map(({ role }) => role));
			const expected = this.#expectedRoles(generation);
			// An empty or unreadable expected set never vouches for serving: fail closed.
			if (
				expected === undefined ||
				rows.some(({ status }) => status !== "granted") ||
				expected.some((role) => !granted.has(role))
			) {
				throw new EndpointReservationError("roles_not_granted", generation);
			}
			this.#database.prepare("UPDATE reservations SET state = 'serving' WHERE generation = ?").run(generation);
			this.#bump(generation);
		});
	}

	/** A granted participant's own `released` commit: its authority ended. */
	release(generation: string, role: ReservationRole, participant: string): void {
		this.#transaction(() => {
			const row = this.#role(generation, role);
			if (!row || row.status !== "granted") throw new EndpointReservationError("role_not_granted", `${role}`);
			if (row.participant !== participant) throw new EndpointReservationError("participant_mismatch", `${role}`);
			this.#database
				.prepare("UPDATE roles SET status = 'released' WHERE generation = ? AND role = ?")
				.run(generation, role);
			this.#bump(generation);
		});
	}

	reservation(generation: string): ReservationRow {
		return this.#reservation(generation);
	}

	roleRow(locator: ReservationLocator): RoleRow | undefined {
		const row = this.#role(locator.generation, locator.role);
		return row && { role: locator.role, status: row.status, issuer: row.issuer, participant: row.participant };
	}

	/** The recorded expected roles, or `undefined` when the record is absent, empty or names a role this build does not know. */
	#expectedRoles(generation: string): ReservationRole[] | undefined {
		const row = this.#database
			.prepare("SELECT expected_roles FROM reservations WHERE generation = ?")
			.get(generation) as { expected_roles: string } | undefined;
		const tokens = row?.expected_roles.split(",") ?? [];
		const roles = tokens.filter((role): role is ReservationRole => role === "supervisor" || role === "host");
		return roles.length > 0 && roles.length === tokens.length ? roles : undefined;
	}

	#transaction<T>(run: () => T): T {
		return this.#read(() => {
			this.#database.exec("BEGIN IMMEDIATE");
			try {
				const result = run();
				// COMMIT can also find the store busy (a reader's shared lock); then nothing of this transition is kept.
				this.#database.exec("COMMIT");
				return result;
			} catch (error: unknown) {
				this.#database.exec("ROLLBACK");
				throw error;
			}
		});
	}

	/** Reads and transitions share the same typed contention refusal; existing domain refusals stay intact. */
	#read<T>(run: () => T): T {
		try {
			return run();
		} catch (error: unknown) {
			if (error instanceof EndpointReservationError) throw error;
			if (isBusy(error))
				throw new EndpointReservationError("store_busy", "another process holds the reservation store");
			throw error;
		}
	}

	#reservation(generation: string): ReservationRow {
		return this.#read(() => {
			const row = this.#database.prepare("SELECT * FROM reservations WHERE generation = ?").get(generation) as
				| ReservationRow
				| undefined;
			if (!row) throw new EndpointReservationError("generation_unknown", generation);
			return { ...row, revision: Number(row.revision) };
		});
	}

	#locate(locator: ReservationLocator): ReservationRow {
		const reservation = this.#reservation(locator.generation);
		if (reservation.endpoint !== locator.endpoint) {
			throw new EndpointReservationError("endpoint_mismatch", locator.generation);
		}
		return reservation;
	}

	#pending(generation: string): void {
		const { state } = this.#reservation(generation);
		if (state === "cancelling") throw new EndpointReservationError("generation_cancelled", generation);
		if (state !== "pending") throw new EndpointReservationError("generation_not_pending", generation);
	}

	#role(
		generation: string,
		role: ReservationRole,
	): { status: RoleStatus; nonce: string | null; issuer: string; participant: string | null } | undefined {
		return this.#read(
			() =>
				this.#database.prepare("SELECT * FROM roles WHERE generation = ? AND role = ?").get(generation, role) as
					| { status: RoleStatus; nonce: string | null; issuer: string; participant: string | null }
					| undefined,
		);
	}

	#bump(generation: string): void {
		this.#database.prepare("UPDATE reservations SET revision = revision + 1 WHERE generation = ?").run(generation);
	}
}
