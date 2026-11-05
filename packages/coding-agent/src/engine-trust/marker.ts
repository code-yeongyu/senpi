/**
 * Marker version 1 of the engine trust launch contract (omo#10762).
 *
 * `SENPI_ENGINE_TRUST` tells a launch which trust generation its native `NODE_EXTRA_CA_CERTS` names
 * and how that generation was made, so the launch can adopt it instead of importing the OS store
 * again. omo's launcher, senpi's spawners and the desktop all write it, so the format lives here,
 * once. A text that is not exactly version 1 is foreign: it costs one import, never trust.
 */
import { z } from "zod";

export const ENGINE_TRUST_MARKER_ENV = "SENPI_ENGINE_TRUST";
/** Set only by the launcher's own trust exec; a launch that carries it never execs again. */
export const ENGINE_TRUST_HOP_ENV = "SENPI_ENGINE_TRUST_HOP";

/** The names a launch records on arrival and an adopting engine restores for its children. */
export const ENGINE_TRUST_RESTORE_NAMES = [
	"NODE_EXTRA_CA_CERTS",
	"NODE_USE_SYSTEM_CA",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"BUN_OPTIONS",
] as const;
export type EngineTrustRestoreName = (typeof ENGINE_TRUST_RESTORE_NAMES)[number];

export const ENGINE_TRUST_FALLBACK_REASONS = [
	"helper-timeout",
	"helper-crash",
	"helper-malformed-output",
	"helper-missing",
	"helper-wrong-arch",
	"helper-signature",
	"access-denied",
	"negatives-incomplete",
	"linux-bundle-unreadable",
	"linux-bundle-malformed",
] as const;

export type EngineTrustContractErrorCode = "trust-marker-invalid" | "trust-path-unrepresentable";

export class EngineTrustContractError extends Error {
	readonly code: EngineTrustContractErrorCode;

	constructor(code: EngineTrustContractErrorCode, message: string) {
		super(message);
		this.name = "EngineTrustContractError";
		this.code = code;
	}
}

const path = z
	.string()
	.min(1)
	.refine((value) => !value.includes("\u0000"));
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const restoreValue = z.string().nullable().optional();

const markerSchema = z
	.strictObject({
		v: z.literal(1),
		file: path,
		sha256: digest,
		automatic: z.enum(["os", "fallback"]),
		fallbackReason: z.enum(ENGINE_TRUST_FALLBACK_REASONS).nullable(),
		owner: z.enum(["server", "standalone"]),
		user: digest.nullable(),
		defaults: z.strictObject({ file: path, dir: path }).nullable(),
		restore: z.strictObject({
			NODE_EXTRA_CA_CERTS: restoreValue,
			NODE_USE_SYSTEM_CA: restoreValue,
			SSL_CERT_FILE: restoreValue,
			SSL_CERT_DIR: restoreValue,
			BUN_OPTIONS: restoreValue,
		}),
	})
	// A fallback names its reason and only a fallback does.
	.refine((marker) => (marker.automatic === "fallback") === (marker.fallbackReason !== null))
	// Only a standalone launch may opt out of the default-input closure (its user chose Bun's inputs),
	// and only a server launch removes, and so records, BUN_OPTIONS.
	.refine((marker) => marker.owner === "standalone" || marker.defaults !== null)
	.refine((marker) => marker.owner === "server" || marker.restore.BUN_OPTIONS === undefined);

export type EngineTrustMarker = Readonly<z.infer<typeof markerSchema>>;
export type EngineTrustRestore = EngineTrustMarker["restore"];

export function parseEngineTrustMarker(text: string): EngineTrustMarker | undefined {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	const parsed = markerSchema.safeParse(json);
	return parsed.success ? parsed.data : undefined;
}

/** One line of JSON; throws rather than write a marker no reader would accept. */
export function serializeEngineTrustMarker(marker: EngineTrustMarker): string {
	const parsed = markerSchema.safeParse(marker);
	if (!parsed.success) {
		throw new EngineTrustContractError("trust-marker-invalid", "engine trust marker is not version 1");
	}
	return JSON.stringify(parsed.data);
}
