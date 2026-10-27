/**
 * The endpoint reservation store of sisyphuslabs/omo-desktop-app#4199 (design 4.2a "Reservation through startup",
 * "Wrapper-safe discovery and one-time claim", "Crash, cancellation and commit"): a private SQLite database beside the
 * endpoint lock, `<endpoint-lock-target>.reservation.db`, with one short `BEGIN IMMEDIATE` transaction per transition.
 *
 * Only an endpoint-lock holder reserves or retires a generation; verified participants claim their role with a one-time
 * 256-bit nonce through a compare-and-set on endpoint, generation, role, nonce and state. The store holds nonces and so
 * is credential-bearing; it never holds the public secret, only a SHA-256 commitment to it. Rows are never deleted:
 * cancellation is a durable `cancelling` state that revokes offers and keeps every claimed identity.
 *
 * Schema 3 (design 4.2a step 4): a granted role records its participant's pre-listen intent, committed in a short
 * transaction that revalidates the generation, role, grant and commitment, so a cancellation fenced after the grant is
 * seen before the bind and the intent stays on record across it for the recovery census.
 *
 * Schema 4 (design 4.2a "Lifetime object and binding", "Placement."): a reservation records the presence root its
 * owner resolved once (canonical path, physical identity, classification) and the owner's kernel-session identity, and
 * every offered role records the presence object predeclared for it in that root. An older record has no presence
 * binding and is refused, never read as protected.
 *
 * Schema 4 (design 4.2a "Acquire before authority; release after quiescence"): the reservation also records the
 * reserving owner's own presence object, which the owner holds before it persists the reservation, and the owner's
 * `released` commit; a role claimed over a predeclared object records that the claimant bound it, and that claim
 * revalidates the revision its claimant read before acquiring. A schema-3 record is refused.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export const ENDPOINT_RESERVATION_SCHEMA = 4;

export type ReservationRole = "supervisor" | "host";
export type ReservationState = "pending" | "cancelling" | "serving";
/** The states this schema writes; a census lists exactly these. */
const RESERVATION_STATES: ReadonlySet<string> = new Set<ReservationState>(["pending", "cancelling", "serving"]);
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
	| "commitment_mismatch"
	| "roles_not_granted"
	| "presence_not_predeclared"
	| "row_malformed"
	| "presence_not_bound"
	| "revision_changed"
	| "owner_mismatch"
	| "owner_not_terminal";

/** Why a reservation has no local presence root. Startup is never refused for that alone. */
export type PresenceUnavailableReason =
	| "unsupported_platform"
	| "native_unavailable"
	| "native_abi_mismatch"
	| "local_app_data_unavailable"
	| "root_unavailable"
	| "root_not_local";

const PRESENCE_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set<PresenceUnavailableReason>([
	"unsupported_platform",
	"native_unavailable",
	"native_abi_mismatch",
	"local_app_data_unavailable",
	"root_unavailable",
	"root_not_local",
]);

/** The presence root the reserving owner resolved once. `placed` roots classified `local` from their opened handle. */
export type PresenceRootRecord =
	| {
			readonly status: "placed";
			/** Beside a store that classified local, or relocated to the per-user root of a not_local store. */
			readonly placement: "beside_store" | "relocated";
			/** The canonical path of the opened directory; issuers, participants and probers open exactly this. */
			readonly path: string;
			readonly volumeSerial: string;
			readonly fileId: string;
			readonly classification: "local";
			readonly fileSystem: string | null;
	  }
	| {
			readonly status: "presence_unavailable";
			readonly reason: PresenceUnavailableReason;
			/** The failed native step and its code, or the not_local reason, for diagnostics only. */
			readonly detail: string | null;
	  };

/** A Windows kernel-session identity (System process creation FILETIME); `unverified` equals nothing. */
export type KernelSessionRecord =
	| { readonly status: "verified"; readonly value: string }
	| { readonly status: "unverified"; readonly reason: string };

export interface ReservationPresence {
	readonly root: PresenceRootRecord;
	readonly ownerKernelSession: KernelSessionRecord;
}

/** The presence object an offer predeclared for its role, created and flushed before the offer committed. */
export type PresenceObjectRecord =
	| {
			readonly status: "predeclared";
			readonly presenceId: string;
			/** `<root path>\\<presenceId>.presence`. */
			readonly path: string;
			/** The object's whole immutable content (random tag, schema, creation time), hex. */
			readonly header: string;
			readonly volumeSerial: string;
			readonly fileId: string;
			readonly classification: "local";
			readonly fileSystem: string | null;
			/** The creating issuer's kernel session. */
			readonly kernelSession: KernelSessionRecord;
			/** For display only. */
			readonly hostLabel: string;
	  }
	| { readonly status: "presence_unavailable" };

/** The only path a predeclared object may have under a placed root. */
export function presenceObjectPath(root: string, presenceId: string): string {
	return `${root}\\${presenceId}.presence`;
}

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
	readonly presence: ReservationPresence;
	/** The reserving owner's own presence object, held from before this row was persisted. */
	readonly ownerPresence: PresenceObjectRecord;
	/** `released` once the owner committed that its authority over this generation ended. */
	readonly ownerStatus: "reserving" | "released";
}

export interface RoleRow {
	readonly role: ReservationRole;
	readonly status: RoleStatus;
	readonly issuer: string;
	readonly participant: string | null;
	/** Whether the granted participant committed its pre-listen intent (design 4.2a step 4). */
	readonly listenIntent: boolean;
	readonly presence: PresenceObjectRecord;
	/** The claimant held the predeclared object when its claim committed. */
	readonly presenceBound: boolean;
}

/** What a claimant holds when it claims: the predeclared object it acquired, at the revision it read before acquiring. */
export interface ClaimPresenceBinding {
	readonly revision: number;
	readonly presenceId: string;
}

/** One reservation in a state this schema writes, with every recorded authority entry, as an admission census reads it. */
export interface ReservationCensusRow {
	readonly generation: string;
	readonly state: ReservationState;
	readonly owner: string;
	readonly roles: readonly Pick<RoleRow, "role" | "status" | "participant">[];
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
	expected_roles TEXT NOT NULL,
	presence_placement TEXT NOT NULL,
	presence_unavailable_reason TEXT,
	presence_unavailable_detail TEXT,
	presence_root_path TEXT,
	presence_root_volume_serial TEXT,
	presence_root_file_id TEXT,
	presence_root_classification TEXT,
	presence_root_file_system TEXT,
	owner_kernel_session TEXT,
	owner_kernel_session_reason TEXT,
	owner_status TEXT NOT NULL,
	owner_presence_status TEXT NOT NULL,
	owner_presence_id TEXT,
	owner_presence_path TEXT,
	owner_presence_header TEXT,
	owner_presence_volume_serial TEXT,
	owner_presence_file_id TEXT,
	owner_presence_classification TEXT,
	owner_presence_file_system TEXT,
	owner_presence_kernel_session TEXT,
	owner_presence_kernel_session_reason TEXT,
	owner_presence_host_label TEXT
);
CREATE TABLE IF NOT EXISTS roles (
	generation TEXT NOT NULL REFERENCES reservations(generation),
	role TEXT NOT NULL,
	nonce TEXT,
	issuer TEXT NOT NULL,
	status TEXT NOT NULL,
	participant TEXT,
	commitment TEXT,
	listen_intent INTEGER NOT NULL DEFAULT 0,
	presence_status TEXT NOT NULL,
	presence_id TEXT,
	presence_path TEXT,
	presence_header TEXT,
	presence_volume_serial TEXT,
	presence_file_id TEXT,
	presence_classification TEXT,
	presence_file_system TEXT,
	presence_kernel_session TEXT,
	presence_kernel_session_reason TEXT,
	presence_host_label TEXT,
	presence_bound INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (generation, role)
);`;

interface ReservationColumns {
	generation: string;
	endpoint: string;
	state: ReservationState;
	revision: number | bigint;
	owner: string;
	presence_placement: string;
	presence_unavailable_reason: string | null;
	presence_unavailable_detail: string | null;
	presence_root_path: string | null;
	presence_root_volume_serial: string | null;
	presence_root_file_id: string | null;
	presence_root_file_system: string | null;
	owner_kernel_session: string | null;
	owner_kernel_session_reason: string | null;
	owner_status: "reserving" | "released";
	owner_presence_status: string;
	owner_presence_id: string | null;
	owner_presence_path: string | null;
	owner_presence_header: string | null;
	owner_presence_volume_serial: string | null;
	owner_presence_file_id: string | null;
	owner_presence_file_system: string | null;
	owner_presence_kernel_session: string | null;
	owner_presence_kernel_session_reason: string | null;
	owner_presence_host_label: string | null;
}

/** One presence object's columns, as the roles table names them. */
interface PresenceColumns {
	presence_status: string;
	presence_id: string | null;
	presence_path: string | null;
	presence_header: string | null;
	presence_volume_serial: string | null;
	presence_file_id: string | null;
	presence_file_system: string | null;
	presence_kernel_session: string | null;
	presence_kernel_session_reason: string | null;
	presence_host_label: string | null;
}

interface RoleColumns extends PresenceColumns {
	status: RoleStatus;
	nonce: string | null;
	issuer: string;
	participant: string | null;
	commitment: string | null;
	listen_intent: number | bigint;
	presence_bound: number | bigint;
}

function kernelSessionColumns(session: KernelSessionRecord): [string | null, string | null] {
	return session.status === "verified" ? [session.value, null] : [null, session.reason];
}

function kernelSessionOf(value: string | null, reason: string | null): KernelSessionRecord {
	return value !== null ? { status: "verified", value } : { status: "unverified", reason: reason ?? "unrecorded" };
}

/**
 * A row that names a placed root or a predeclared object but lacks one of its columns, or names a placement or reason
 * this schema does not write, is unreadable evidence (design 4.2a Revision 6, "Missing/replaced/unverifiable objects
 * are unknown"). It is never read as a row that recorded no presence: the read refuses typed, and nothing repairs it.
 */
function malformed(generation: string, what: string): EndpointReservationError {
	return new EndpointReservationError("row_malformed", `${what} in ${generation}`);
}

function reservationPresenceOf(row: ReservationColumns): ReservationPresence {
	const ownerKernelSession = kernelSessionOf(row.owner_kernel_session, row.owner_kernel_session_reason);
	if (row.presence_placement === "beside_store" || row.presence_placement === "relocated") {
		if (
			row.presence_root_path === null ||
			row.presence_root_volume_serial === null ||
			row.presence_root_file_id === null
		) {
			throw malformed(row.generation, `${row.presence_placement} root missing a column`);
		}
		return {
			root: {
				status: "placed",
				placement: row.presence_placement,
				path: row.presence_root_path,
				volumeSerial: row.presence_root_volume_serial,
				fileId: row.presence_root_file_id,
				classification: "local",
				fileSystem: row.presence_root_file_system,
			},
			ownerKernelSession,
		};
	}
	if (row.presence_placement !== "presence_unavailable") {
		throw malformed(row.generation, `placement ${JSON.stringify(row.presence_placement)}`);
	}
	const reason = row.presence_unavailable_reason;
	if (reason === null || !PRESENCE_UNAVAILABLE_REASONS.has(reason)) {
		throw malformed(row.generation, `unavailable reason ${JSON.stringify(reason)}`);
	}
	return {
		root: {
			status: "presence_unavailable",
			reason: reason as PresenceUnavailableReason,
			detail: row.presence_unavailable_detail,
		},
		ownerKernelSession,
	};
}

function presenceObjectOf(row: PresenceColumns, generation: string): PresenceObjectRecord {
	if (row.presence_status === "presence_unavailable") return { status: "presence_unavailable" };
	if (row.presence_status !== "predeclared") {
		throw malformed(generation, `presence status ${JSON.stringify(row.presence_status)}`);
	}
	if (
		row.presence_id === null ||
		row.presence_path === null ||
		row.presence_header === null ||
		row.presence_volume_serial === null ||
		row.presence_file_id === null
	) {
		throw malformed(generation, "predeclared object missing a column");
	}
	return {
		status: "predeclared",
		presenceId: row.presence_id,
		path: row.presence_path,
		header: row.presence_header,
		volumeSerial: row.presence_volume_serial,
		fileId: row.presence_file_id,
		classification: "local",
		fileSystem: row.presence_file_system,
		kernelSession: kernelSessionOf(row.presence_kernel_session, row.presence_kernel_session_reason),
		hostLabel: row.presence_host_label ?? "",
	};
}

function ownerPresenceOf(row: ReservationColumns): PresenceObjectRecord {
	return presenceObjectOf(
		{
			presence_status: row.owner_presence_status,
			presence_id: row.owner_presence_id,
			presence_path: row.owner_presence_path,
			presence_header: row.owner_presence_header,
			presence_volume_serial: row.owner_presence_volume_serial,
			presence_file_id: row.owner_presence_file_id,
			presence_file_system: row.owner_presence_file_system,
			presence_kernel_session: row.owner_presence_kernel_session,
			presence_kernel_session_reason: row.owner_presence_kernel_session_reason,
			presence_host_label: row.owner_presence_host_label,
		},
		row.generation,
	);
}

/** The eleven presence-object column values, in the order both tables declare them. */
function presenceObjectValues(presence: PresenceObjectRecord): (string | null)[] {
	const object = presence.status === "predeclared" ? presence : undefined;
	const [session, sessionReason] = object ? kernelSessionColumns(object.kernelSession) : [null, null];
	return [
		presence.status,
		object?.presenceId ?? null,
		object?.path ?? null,
		object?.header ?? null,
		object?.volumeSerial ?? null,
		object?.fileId ?? null,
		object?.classification ?? null,
		object?.fileSystem ?? null,
		session,
		sessionReason,
		object?.hostLabel ?? null,
	];
}

/** A placed root takes only an object predeclared inside it; a root without presence takes none. */
function presenceMatchesRoot(root: PresenceRootRecord, object: PresenceObjectRecord): boolean {
	if (root.status !== "placed") return object.status === "presence_unavailable";
	return (
		object.status === "predeclared" &&
		/^[0-9a-f]{32}$/.test(object.presenceId) &&
		object.path === presenceObjectPath(root.path, object.presenceId) &&
		object.volumeSerial === root.volumeSerial
	);
}

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
	return new EndpointReservationStore(database, path);
}

export class EndpointReservationStore {
	readonly #database: Database;
	/** The store's file, which a launch locator names. */
	readonly path: string;

	constructor(database: Database, path: string) {
		this.#database = database;
		this.path = path;
	}

	close(): void {
		this.#database.close();
	}

	/**
	 * Creates a pending generation that expects exactly `expectedRoles` (design 4.2a, the minimum record). The ensure path,
	 * which admits a supervisor that admits a host, expects both; a self-reserving direct supervisor expects only its host
	 * child; a standalone public host, reserving itself with no child hop, expects (and self-offers) only "host". Unknown
	 * or absent roles are refused. The caller holds the endpoint lock and, when the root is placed, already holds
	 * `ownerPresence`, its own object predeclared in that root ("Acquire before authority").
	 */
	reserve(
		endpoint: string,
		owner: string,
		expectedRoles: readonly ReservationRole[],
		presence: ReservationPresence,
		ownerPresence: PresenceObjectRecord,
	): string {
		const roles = [...new Set(expectedRoles)].sort();
		if (roles.length === 0) throw new EndpointReservationError("role_not_expected", "a reservation expects no role");
		const unknown = roles.filter((role) => role !== "supervisor" && role !== "host");
		if (unknown.length > 0)
			throw new EndpointReservationError("role_not_expected", `unknown role ${unknown.join(",")}`);
		const generation = randomBytes(16).toString("hex");
		const { root } = presence;
		if (!presenceMatchesRoot(root, ownerPresence)) {
			throw new EndpointReservationError("presence_not_predeclared", `the reserving owner of ${generation}`);
		}
		const placed = root.status === "placed" ? root : undefined;
		const unavailable = root.status === "presence_unavailable" ? root : undefined;
		this.#transaction(() => {
			this.#database
				.prepare(
					`INSERT INTO reservations (generation, endpoint, state, revision, owner, expected_roles, presence_placement,
					presence_unavailable_reason, presence_unavailable_detail, presence_root_path, presence_root_volume_serial,
					presence_root_file_id, presence_root_classification, presence_root_file_system, owner_kernel_session,
					owner_kernel_session_reason, owner_status, owner_presence_status, owner_presence_id, owner_presence_path,
					owner_presence_header, owner_presence_volume_serial, owner_presence_file_id, owner_presence_classification,
					owner_presence_file_system, owner_presence_kernel_session, owner_presence_kernel_session_reason,
					owner_presence_host_label)
					VALUES (?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserving', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					generation,
					endpoint,
					owner,
					roles.join(","),
					placed?.placement ?? "presence_unavailable",
					unavailable?.reason ?? null,
					unavailable?.detail ?? null,
					placed?.path ?? null,
					placed?.volumeSerial ?? null,
					placed?.fileId ?? null,
					placed?.classification ?? null,
					placed?.fileSystem ?? null,
					...kernelSessionColumns(presence.ownerKernelSession),
					...presenceObjectValues(ownerPresence),
				);
		});
		return generation;
	}

	/**
	 * Offers `role` with a fresh nonce, issued by `issuer`, before the launcher spawns it. `presence` is the role's object,
	 * already created and flushed in the reservation's recorded root (or `presence_unavailable` when the reservation has
	 * no local root); anything else is refused.
	 */
	offer(generation: string, role: ReservationRole, issuer: string, presence: PresenceObjectRecord): void {
		this.#transaction(() => {
			this.#pending(generation);
			if (!this.#expectedRoles(generation)?.includes(role)) {
				throw new EndpointReservationError("role_not_expected", `${role} in ${generation}`);
			}
			if (this.#role(generation, role)) {
				throw new EndpointReservationError("role_already_offered", `${role} in ${generation}`);
			}
			if (!presenceMatchesRoot(this.#reservation(generation).presence.root, presence)) {
				throw new EndpointReservationError("presence_not_predeclared", `${role} in ${generation}`);
			}
			this.#database
				.prepare(
					`INSERT INTO roles (generation, role, nonce, issuer, status, presence_status, presence_id, presence_path,
					presence_header, presence_volume_serial, presence_file_id, presence_classification, presence_file_system,
					presence_kernel_session, presence_kernel_session_reason, presence_host_label)
					VALUES (?, ?, ?, ?, 'offered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(generation, role, randomBytes(32).toString("hex"), issuer, ...presenceObjectValues(presence));
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
	 *
	 * A role with a predeclared presence object is claimed only with `binding`: the claimant already holds that object
	 * (design 4.2a "Acquire before authority"), and the reservation must still be at the revision it read before
	 * acquiring, so a cancellation, retirement or new offer in between refuses the claim. The claim records the binding.
	 */
	claim(
		locator: ReservationLocator,
		nonce: Uint8Array,
		participant: string,
		binding?: ClaimPresenceBinding,
	): "claimed" | "already_claimed_by_caller" {
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
			const predeclared = row.presence_status === "predeclared";
			if (predeclared && (binding === undefined || binding.presenceId !== row.presence_id)) {
				throw new EndpointReservationError("presence_not_bound", `${locator.role} in ${locator.generation}`);
			}
			if (binding !== undefined && binding.revision !== reservation.revision) {
				throw new EndpointReservationError("revision_changed", `${locator.role} in ${locator.generation}`);
			}
			const expected = Buffer.from(row.nonce ?? "", "hex");
			if (expected.length !== 32 || nonce.length !== 32 || !timingSafeEqual(expected, nonce)) {
				throw new EndpointReservationError("nonce_mismatch", `${locator.role} in ${locator.generation}`);
			}
			// The compare-and-set itself: only the row still offered with this exact nonce changes.
			const changed = this.#database
				.prepare(
					"UPDATE roles SET status = 'claimed', nonce = NULL, participant = ?, presence_bound = ? WHERE generation = ? AND role = ? AND status = 'offered' AND nonce = ?",
				)
				.run(participant, predeclared ? 1 : 0, locator.generation, locator.role, expected.toString("hex")) as {
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
	 * The granted participant's pre-listen intent (design 4.2a step 4): one short transaction that revalidates the
	 * generation (pending, this endpoint), the role's grant to exactly this participant and the commitment it is about
	 * to serve, then records the intent. A generation cancelled after the grant refuses it, so the cancellation cannot go
	 * unnoticed merely because the optional notification was lost; the grant itself stays on record either way.
	 */
	commitListenIntent(locator: ReservationLocator, participant: string, commitment: Uint8Array): void {
		this.#transaction(() => {
			this.#locate(locator);
			this.#pending(locator.generation);
			const row = this.#role(locator.generation, locator.role);
			if (!row || row.status !== "granted") {
				throw new EndpointReservationError("role_not_granted", `${locator.role} in ${locator.generation}`);
			}
			if (row.participant !== participant) {
				throw new EndpointReservationError("participant_mismatch", `${locator.role} in ${locator.generation}`);
			}
			const granted = Buffer.from(row.commitment ?? "", "hex");
			if (granted.length !== 32 || commitment.length !== 32 || !timingSafeEqual(granted, commitment)) {
				throw new EndpointReservationError("commitment_mismatch", `${locator.role} in ${locator.generation}`);
			}
			this.#database
				.prepare("UPDATE roles SET listen_intent = 1 WHERE generation = ? AND role = ?")
				.run(locator.generation, locator.role);
			this.#bump(locator.generation);
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

	/**
	 * The reserving owner's own `released` commit, once the generation is terminal for it (serving or cancelling) and it
	 * takes no further action there: the quiescence receipt that precedes closing its presence guard.
	 */
	releaseOwner(generation: string, owner: string): void {
		this.#transaction(() => {
			const reservation = this.#reservation(generation);
			if (reservation.owner !== owner) throw new EndpointReservationError("owner_mismatch", generation);
			if (reservation.state === "pending") throw new EndpointReservationError("owner_not_terminal", generation);
			this.#database
				.prepare("UPDATE reservations SET owner_status = 'released' WHERE generation = ?")
				.run(generation);
			this.#bump(generation);
		});
	}

	reservation(generation: string): ReservationRow {
		return this.#reservation(generation);
	}

	roleRow(locator: ReservationLocator): RoleRow | undefined {
		const row = this.#role(locator.generation, locator.role);
		return (
			row && {
				role: locator.role,
				status: row.status,
				issuer: row.issuer,
				participant: row.participant,
				listenIntent: Number(row.listen_intent) === 1,
				presence: presenceObjectOf(row, locator.generation),
				presenceBound: Number(row.presence_bound) === 1,
			}
		);
	}

	/** The roles the reserving owner expects in `generation`; `undefined` when the record is absent or unreadable. */
	expectedRoles(generation: string): readonly ReservationRole[] | undefined {
		return this.#read(() => this.#expectedRoles(generation));
	}

	/**
	 * Every reservation of this store, with its role rows, for the owner census an admission takes before public-secret
	 * recovery (design 4.2a "Admission BEFORE mutation"). Every state this schema writes (`RESERVATION_STATES`) is listed;
	 * a row in a state this build does not know is unreadable evidence and refuses with `row_malformed`, never listed as
	 * one of them and never dropped. The store is keyed by the physical endpoint, so no endpoint filter is applied: a
	 * spelling the reserving writer chose must not hide its generation. Read-only.
	 */
	census(): readonly ReservationCensusRow[] {
		return this.#read(() => {
			const rows = this.#database
				.prepare("SELECT generation, state, owner FROM reservations ORDER BY rowid")
				.all() as { generation: string; state: string; owner: string }[];
			const reservations = rows.map((row) => {
				if (!RESERVATION_STATES.has(row.state)) {
					throw new EndpointReservationError(
						"row_malformed",
						`state ${JSON.stringify(row.state)} in ${row.generation}`,
					);
				}
				return { ...row, state: row.state as ReservationState };
			});
			const roles = this.#database.prepare(
				"SELECT role, status, participant FROM roles WHERE generation = ? ORDER BY role",
			);
			return reservations.map((reservation) => ({
				...reservation,
				roles: roles.all(reservation.generation) as {
					role: ReservationRole;
					status: RoleStatus;
					participant: string | null;
				}[],
			}));
		});
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

	/** The role granted to `participant`, with its commitment; `undefined` until that exact participant is granted. */
	grantedRole(locator: ReservationLocator, participant: string): { readonly commitment: string } | undefined {
		return this.#read(() => {
			this.#locate(locator);
			const row = this.#database
				.prepare("SELECT status, participant, commitment FROM roles WHERE generation = ? AND role = ?")
				.get(locator.generation, locator.role) as
				| { status: RoleStatus; participant: string | null; commitment: string | null }
				| undefined;
			if (row?.status !== "granted" || row.participant !== participant || row.commitment === null) return undefined;
			return { commitment: row.commitment };
		});
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
				| ReservationColumns
				| undefined;
			if (!row) throw new EndpointReservationError("generation_unknown", generation);
			return {
				endpoint: row.endpoint,
				generation: row.generation,
				state: row.state,
				revision: Number(row.revision),
				owner: row.owner,
				presence: reservationPresenceOf(row),
				ownerPresence: ownerPresenceOf(row),
				ownerStatus: row.owner_status,
			};
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

	#role(generation: string, role: ReservationRole): RoleColumns | undefined {
		return this.#read(
			() =>
				this.#database.prepare("SELECT * FROM roles WHERE generation = ? AND role = ?").get(generation, role) as
					| RoleColumns
					| undefined,
		);
	}

	#bump(generation: string): void {
		this.#database.prepare("UPDATE reservations SET revision = revision + 1 WHERE generation = ?").run(generation);
	}
}
