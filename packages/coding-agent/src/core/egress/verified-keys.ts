/**
 * This device's own key-check records (`LocalKeyVerification`) and service-entry validity (custody design
 * 2.2 / 3.1).
 *
 * One JSON file under `<agentDir>/state/custody/verified-keys.json`, shared by relayd and the CLI/hand
 * process. A record binds the checked KEYS (SPKI hashes, ARNs, template version, account), not only their
 * ids, so an attacker entry that copies the ids of a checked key never matches. A record only ever grants
 * validity, so the read side fails closed: a file that exists but cannot be parsed reads as `unknown`.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { lockWithLossHandling } from "../file-lock.ts";
import { decodeBase64 } from "./ecdsa-p256.ts";
import { type RosterView, type ServiceKeyEntry, type ServiceKeyKind, verifyServiceSig } from "./roster-entries.ts";

export interface LocalKeyVerification {
	readonly kind: ServiceKeyKind;
	readonly accountId: string;
	readonly generation: number;
	readonly sigKeyId: string;
	readonly sigPkSha256: string;
	readonly kemKeyId?: string;
	readonly kemPkSha256?: string;
	readonly kmsKeyArns: readonly string[];
	readonly templateVersion: number;
	/** The `sigKeyId` this checked entry revokes; persisted so a roster rollback cannot un-revoke it. */
	readonly supersedes?: string;
	readonly checkedAt: number;
}

export type VerifiedKeysRead =
	| { readonly state: "ok"; readonly records: readonly LocalKeyVerification[] }
	| { readonly state: "unknown" };

export type ServiceEntryValidity = "valid" | "pending" | "invalid" | "unknown" | "superseded";

const REQUIRED_STRINGS = ["accountId", "sigKeyId", "sigPkSha256"] as const;
const OPTIONAL_STRINGS = ["kemKeyId", "kemPkSha256", "supersedes"] as const;
const RECORD_KEYS: readonly string[] = [
	"kind",
	"generation",
	"kmsKeyArns",
	"templateVersion",
	"checkedAt",
	...REQUIRED_STRINGS,
	...OPTIONAL_STRINGS,
];

export function verifiedKeysPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "state", "custody", "verified-keys.json");
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function parseRecord(value: unknown): LocalKeyVerification | undefined {
	if (!isRecord(value)) return undefined;
	const raw = value;
	if (!Object.keys(raw).every((key) => RECORD_KEYS.includes(key))) return undefined;
	const {
		kind,
		accountId,
		generation,
		sigKeyId,
		sigPkSha256,
		kemKeyId,
		kemPkSha256,
		kmsKeyArns,
		templateVersion,
		supersedes,
		checkedAt,
	} = raw;
	if (kind !== "custody" && kind !== "placement-registry") return undefined;
	if (!isText(accountId) || !isText(sigKeyId) || !isText(sigPkSha256)) return undefined;
	if (!isCount(generation) || !isCount(templateVersion) || !isCount(checkedAt)) return undefined;
	if (!Array.isArray(kmsKeyArns) || !kmsKeyArns.every(isText)) return undefined;
	if ([kemKeyId, kemPkSha256, supersedes].some((optional) => optional !== undefined && !isText(optional)))
		return undefined;
	return {
		kind,
		accountId,
		generation,
		sigKeyId,
		sigPkSha256,
		...(isText(kemKeyId) ? { kemKeyId } : {}),
		...(isText(kemPkSha256) ? { kemPkSha256 } : {}),
		kmsKeyArns: [...kmsKeyArns],
		templateVersion,
		...(isText(supersedes) ? { supersedes } : {}),
		checkedAt,
	};
}

function parseFile(text: string): readonly LocalKeyVerification[] | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const file = value;
	if (file.v !== 2 || !Array.isArray(file.records)) return undefined;
	const records: LocalKeyVerification[] = [];
	for (const raw of file.records) {
		const record = parseRecord(raw);
		if (!record) return undefined;
		records.push(record);
	}
	return records;
}

export async function readVerifiedKeys(path: string): Promise<VerifiedKeysRead> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return missing ? { state: "ok", records: [] } : { state: "unknown" };
	}
	const records = parseFile(text);
	return records ? { state: "ok", records } : { state: "unknown" };
}

async function spkiSha256(spkiBase64: string): Promise<string | undefined> {
	const bytes = decodeBase64(spkiBase64);
	if (!bytes) return undefined;
	return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("base64");
}

/**
 * The record this device stores after `checkServiceKey` returned `ok` for `entry`. `undefined` when the
 * entry belongs to another account or its self-signature does not verify: such an entry can never be recorded.
 */
export async function verificationFor(
	entry: ServiceKeyEntry,
	accountId: string,
	checkedAt: number,
): Promise<LocalKeyVerification | undefined> {
	if (entry.accountId !== accountId || !(await verifyServiceSig(entry))) return undefined;
	const sigPkSha256 = await spkiSha256(entry.sigPk);
	const kemPkSha256 = entry.kemPk === undefined ? undefined : await spkiSha256(entry.kemPk);
	if (!sigPkSha256 || (entry.kemPk !== undefined && !kemPkSha256)) return undefined;
	return {
		kind: entry.kind,
		accountId: entry.accountId,
		generation: entry.generation,
		sigKeyId: entry.sigKeyId,
		sigPkSha256,
		...(entry.kemKeyId === undefined ? {} : { kemKeyId: entry.kemKeyId }),
		...(kemPkSha256 === undefined ? {} : { kemPkSha256 }),
		kmsKeyArns: [...entry.kmsKeyArns],
		templateVersion: entry.templateVersion,
		...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
		checkedAt,
	};
}

function sameBinding(a: LocalKeyVerification, b: LocalKeyVerification): boolean {
	return (
		a.kind === b.kind &&
		a.accountId === b.accountId &&
		a.generation === b.generation &&
		a.sigKeyId === b.sigKeyId &&
		a.sigPkSha256 === b.sigPkSha256 &&
		a.kemKeyId === b.kemKeyId &&
		a.kemPkSha256 === b.kemPkSha256 &&
		a.templateVersion === b.templateVersion &&
		a.supersedes === b.supersedes &&
		a.kmsKeyArns.length === b.kmsKeyArns.length &&
		a.kmsKeyArns.every((arn, index) => arn === b.kmsKeyArns[index])
	);
}

export async function findVerification(
	records: readonly LocalKeyVerification[],
	entry: ServiceKeyEntry,
): Promise<LocalKeyVerification | undefined> {
	const expected = await verificationFor(entry, entry.accountId, 0);
	return expected && records.find((record) => sameBinding(record, expected));
}

/**
 * Validity of a service entry FOR THIS DEVICE in `accountId`. Only this device's own records count; other
 * devices' attestations and revocations never do. Two differently keyed, validly signed entries for one
 * (kind, account, generation) make the entry `unknown`. Supersession comes from this device's records only
 * (a checked entry of the same kind and account, strictly higher generation, naming this `sigKeyId`), so it
 * cannot be undone by an entry disappearing from a later roster.
 */
export async function serviceEntryValidity(
	entry: ServiceKeyEntry,
	accountId: string,
	records: readonly LocalKeyVerification[],
	roster: RosterView,
): Promise<ServiceEntryValidity> {
	if (roster.state === "unknown") return "unknown";
	if (entry.accountId !== accountId || !(await verifyServiceSig(entry))) return "invalid";
	for (const other of roster.serviceEntries) {
		if (other.kind !== entry.kind || other.accountId !== entry.accountId || other.generation !== entry.generation)
			continue;
		const sameKey = other.sigKeyId === entry.sigKeyId && other.sigPk === entry.sigPk && other.kemPk === entry.kemPk;
		if (!sameKey && (await verifyServiceSig(other))) return "unknown";
	}
	const revoked = records.some(
		(record) =>
			record.kind === entry.kind &&
			record.accountId === entry.accountId &&
			record.generation > entry.generation &&
			record.supersedes === entry.sigKeyId,
	);
	if (revoked) return "superseded";
	return (await findVerification(records, entry)) ? "valid" : "pending";
}

export async function recordVerification(path: string, record: LocalKeyVerification): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const lock = await lockWithLossHandling(dir, {
		realpath: false,
		lockfilePath: `${path}.lock`,
		retries: { retries: 50, minTimeout: 20, maxTimeout: 200 },
	});
	try {
		const current = await readVerifiedKeys(path);
		// An unreadable file is replaced: dropping records only forces re-checks, never grants trust.
		const kept = current.state === "ok" ? current.records : [];
		const replaced = (existing: LocalKeyVerification) =>
			existing.kind === record.kind &&
			existing.accountId === record.accountId &&
			existing.generation === record.generation &&
			existing.sigKeyId === record.sigKeyId;
		const next = { v: 2, records: [...kept.filter((existing) => !replaced(existing)), record] };
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		await chmod(tmp, 0o600);
		lock.assertHeld();
		await rename(tmp, path);
	} finally {
		await lock.release();
	}
}
