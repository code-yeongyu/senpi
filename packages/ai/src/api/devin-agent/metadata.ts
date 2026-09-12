/**
 * Cascade `Metadata` construction.
 *
 * Cascade gates behavior on the caller's identity tuple, and the two identities
 * below are the ones the released Devin CLI actually presents:
 * - the released chat identity (`devin-cli` / `chisel`) unlocks the CLI model
 *   surface and router assignment on `GetUserJwt`, `AssignModel` and
 *   `GetChatMessage`;
 * - the dev-channel `chisel` identity is what the CLI announces on
 *   `GetCliModelConfigs`, and it is the one that returns the full catalog.
 *
 * The session token is scheme-prefixed on the wire, and `userJwt` stays empty
 * for the calls the CLI makes with the session token alone.
 */

import { create } from "@bufbuild/protobuf";
import {
	type DisplayOption,
	DisplayOption as DisplayOptionValue,
	type Metadata,
	MetadataSchema,
} from "./gen/cascade_pb.ts";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

const DEVIN_OS = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const DEVIN_LOCALE = "en";

export const DEVIN_CLI_IDENTITY = {
	ideName: "devin-cli",
	ideType: "chisel",
	ideVersion: "3000.6.2",
	extensionName: "chisel",
	extensionVersion: "3000.6.2",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

export const DEVIN_DISCOVERY_IDENTITY = {
	ideName: "chisel",
	ideVersion: "0.0.0-dev",
	extensionName: "chisel",
	extensionVersion: "0.0.0-dev",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

/**
 * Asking for the internal slots is what makes Cascade return its full catalog;
 * the internal ones are filtered client-side, exactly as the native client does.
 */
export const DEVIN_SUPPORTED_MODEL_DISPLAYS: readonly DisplayOption[] = [
	DisplayOptionValue.MODEL_ROUTER,
	DisplayOptionValue.QUICK_REVIEW,
	DisplayOptionValue.INTERNAL_DEFAULT,
	DisplayOptionValue.UNCLASSIFIED,
	DisplayOptionValue.NORMAL,
];

/** Session token as the wire format carries it: the scheme prefix is required. */
export function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

export function devinCliMetadata(apiKey: string | undefined, userJwt = ""): Metadata {
	return create(MetadataSchema, {
		...DEVIN_CLI_IDENTITY,
		apiKey: normalizeDevinSessionToken(apiKey),
		userJwt,
	});
}

export function devinDiscoveryMetadata(apiKey: string | undefined): Metadata {
	return create(MetadataSchema, {
		...DEVIN_DISCOVERY_IDENTITY,
		apiKey: normalizeDevinSessionToken(apiKey),
		supportedModelDisplays: [...DEVIN_SUPPORTED_MODEL_DISPLAYS],
	});
}
