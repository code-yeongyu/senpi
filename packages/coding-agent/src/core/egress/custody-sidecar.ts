/**
 * The custody sidecar `<agentDir>/custody.json` (custody design 4.1, row CK5).
 *
 * It lives beside models.json, never inside it, so fused parsers and older CLIs never see a custody
 * field. Only the device service writes it (temp file + rename); the fused CLI never reads it.
 * A read is tri-state so a caller can tell "not enabled" (absent) from "broken" (invalid).
 */

import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const CUSTODY_SIDECAR_FILE = "custody.json";

const SignedRecordSchema = Type.Record(Type.String(), Type.Unknown());

const ProviderCustodySchema = Type.Object(
	{
		custody: Type.Optional(Type.Union([Type.Literal("sealed"), Type.Literal("device")])),
		apiKeyTtlSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
		headersTtlSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
		sealedCwdHash: Type.Optional(Type.String({ minLength: 1 })),
		secretUrlParts: Type.Optional(
			Type.Array(Type.String({ pattern: "^(urlPath:(0|[1-9][0-9]*)|urlQuery:.+)$" }), { uniqueItems: true }),
		),
	},
	{ additionalProperties: false },
);

const CustodySidecarSchema = Type.Object(
	{
		v: Type.Literal(1),
		providers: Type.Record(Type.String({ minLength: 1 }), ProviderCustodySchema),
		consent: Type.Optional(SignedRecordSchema),
		withdrawal: Type.Optional(SignedRecordSchema),
	},
	{ additionalProperties: false },
);

const validateCustodySidecar = Compile(CustodySidecarSchema);

export type CustodySidecar = Static<typeof CustodySidecarSchema>;
export type ProviderCustody = Static<typeof ProviderCustodySchema>;

export type CustodySidecarRead =
	| { readonly state: "absent" }
	| { readonly state: "ok"; readonly sidecar: CustodySidecar }
	| { readonly state: "invalid"; readonly reason: string };

export function custodySidecarPath(agentDir: string): string {
	return join(agentDir, CUSTODY_SIDECAR_FILE);
}

function parseCustodySidecar(text: string): CustodySidecarRead {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return { state: "invalid", reason: `not JSON: ${error.message}` };
		throw error;
	}
	if (validateCustodySidecar.Check(value)) return { state: "ok", sidecar: value };
	const first = validateCustodySidecar.Errors(value)[0];
	return { state: "invalid", reason: first ? `${first.instancePath || "/"} ${first.message}` : "schema mismatch" };
}

export async function readCustodySidecar(path: string): Promise<CustodySidecarRead> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isErrnoCode(error, "ENOENT")) return { state: "absent" };
		throw error;
	}
	return parseCustodySidecar(text);
}

/** Writes the whole sidecar atomically: a 0600 temp file in the same directory, fsync, rename, fsync dir. */
export async function writeCustodySidecar(path: string, sidecar: CustodySidecar): Promise<void> {
	if (!validateCustodySidecar.Check(sidecar)) throw new TypeError("custody sidecar does not match its schema");
	const directory = dirname(path);
	const temp = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	const file = await open(temp, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(sidecar, null, "\t")}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	const dir = await open(directory, "r");
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}

function isErrnoCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
