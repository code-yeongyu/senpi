/**
 * Signed revocations of key-facts verifier keys (custody design 15.10 "Signed revocation statements", 15.15 M-3).
 *
 * Accepted revocations persist monotonically in `<agentDir>/state/custody/verifier-revocations.json`: a write
 * only adds, and an unreadable file is never replaced, because replacing it would un-revoke a key.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { lockWithLossHandling } from "../file-lock.ts";
import { hasExactKeys, isRecord, type StatementFields, type VerifierKeyPin } from "./signed-statement.ts";

/** A whole key, or (with `from` and `to`) only the statements it signed with `readAt` in `[from, to]`. */
export interface VerifierRevocation {
	readonly keyId: string;
	readonly from?: number;
	readonly to?: number;
}

export type VerifierRevocationsRead =
	| { readonly state: "ok"; readonly revocations: readonly VerifierRevocation[] }
	| { readonly state: "unknown" };

export interface RevocationFreshness {
	readonly issuedAt: number;
	readonly fetchedMono: number;
}

export const REVOCATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function verifierRevocationsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "state", "custody", "verifier-revocations.json");
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseRevocation(value: unknown): VerifierRevocation | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ["keyId"], ["from", "to"])) return undefined;
	const { keyId, from, to } = value;
	if (typeof keyId !== "string" || keyId.length === 0) return undefined;
	if (from === undefined && to === undefined) return { keyId };
	return isCount(from) && isCount(to) && from <= to ? { keyId, from, to } : undefined;
}

function parseRevocations(value: unknown): VerifierRevocation[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed = value.map(parseRevocation);
	return parsed.every((revocation) => revocation !== undefined) ? parsed : undefined;
}

export function parseRevocationsStatement(
	fields: StatementFields,
	nonce: string,
): { readonly issuedAt: number; readonly revocations: readonly VerifierRevocation[] } | undefined {
	if (!hasExactKeys(fields, ["v", "kind", "nonce", "issuedAt", "revocations", "verifierKeyId"])) return undefined;
	if (fields.kind !== "revocations" || fields.nonce !== nonce || !isCount(fields.issuedAt)) return undefined;
	const revocations = parseRevocations(fields.revocations);
	return revocations && { issuedAt: fields.issuedAt, revocations };
}

export function isKeyRevoked(revocations: readonly VerifierRevocation[], keyId: string): boolean {
	return revocations.some((revocation) => revocation.keyId === keyId && revocation.from === undefined);
}

export function isVouchRevoked(revocations: readonly VerifierRevocation[], verifierKeyId: string, vouchedAt: number) {
	return revocations.some(
		(revocation) =>
			revocation.keyId === verifierKeyId &&
			(revocation.from === undefined ||
				(revocation.to !== undefined && revocation.from <= vouchedAt && vouchedAt <= revocation.to)),
	);
}

/**
 * The entries of a statement signed by `signer` that this device accepts. A whole-key revocation needs a signer
 * of a strictly higher pinned generation, a window revocation the same or a higher one; the signer must not be
 * revoked itself. A key this release does not pin is never revoked here, so a stored revocation cannot block a
 * generation a later release pins.
 */
export function acceptedRevocations(
	entries: readonly VerifierRevocation[],
	signer: VerifierKeyPin,
	pins: readonly VerifierKeyPin[],
	held: readonly VerifierRevocation[],
): VerifierRevocation[] {
	if (isKeyRevoked(held, signer.keyId)) return [];
	return entries.filter((entry) => {
		const target = pins.find((pin) => pin.keyId === entry.keyId);
		if (!target) return false;
		return entry.from === undefined ? target.generation < signer.generation : target.generation <= signer.generation;
	});
}

/**
 * Whether a record vouched at `vouchedAt` may authorize a NEW wrap: this process holds a verified statement issued
 * at or after `vouchedAt` (both times verifier-signed, one clock) and fetched at most 6 h ago on the monotonic
 * clock. No fetch, no new wrap.
 */
export function newWrapAllowed(vouchedAt: number, freshness: RevocationFreshness | undefined, nowMono: number) {
	if (!freshness || freshness.issuedAt < vouchedAt) return false;
	const age = nowMono - freshness.fetchedMono;
	return age >= 0 && age <= REVOCATION_MAX_AGE_MS;
}

export async function readVerifierRevocations(path: string): Promise<VerifierRevocationsRead> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return missing ? { state: "ok", revocations: [] } : { state: "unknown" };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { state: "unknown" };
	}
	const revocations = isRecord(value) && value.v === 1 ? parseRevocations(value.revocations) : undefined;
	return revocations ? { state: "ok", revocations } : { state: "unknown" };
}

const sameRevocation = (a: VerifierRevocation, b: VerifierRevocation) =>
	a.keyId === b.keyId && a.from === b.from && a.to === b.to;

export async function recordVerifierRevocations(
	path: string,
	accepted: readonly VerifierRevocation[],
): Promise<boolean> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const stop = new AbortController();
	const lock = await lockWithLossHandling(dir, {
		realpath: false,
		lockfilePath: `${path}.lock`,
		retries: { retries: 50, minTimeout: 20, maxTimeout: 200 },
		// A lost lock aborts the temp-file write, so nothing more is written after the loss.
		onLost: (error) => stop.abort(error),
	});
	try {
		const current = await readVerifierRevocations(path);
		if (current.state !== "ok") return false;
		const added = accepted.filter(
			(revocation, index) =>
				!current.revocations.some((held) => sameRevocation(held, revocation)) &&
				accepted.findIndex((other) => sameRevocation(other, revocation)) === index,
		);
		const next = { v: 1, revocations: [...current.revocations, ...added] };
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, signal: stop.signal });
		await chmod(tmp, 0o600);
		lock.assertHeld();
		await rename(tmp, path);
		return true;
	} catch (error) {
		lock.assertHeld();
		throw error;
	} finally {
		await lock.release();
	}
}
