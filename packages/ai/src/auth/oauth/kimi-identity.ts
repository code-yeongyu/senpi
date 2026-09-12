/**
 * Kimi Code client identity headers.
 *
 * `api.kimi.com/coding` identifies its clients by a product `User-Agent` plus
 * an `X-Msh-*` device header set, and the official Kimi Code client sends that
 * set on every OAuth and managed-API request (MoonshotAI/kimi-code
 * `packages/oauth/src/identity.ts`). senpi sent none of them, so a
 * subscription session never identified itself as a Kimi client at all.
 *
 * Three contract details that are not visible from the code: values must be
 * printable ASCII (the endpoint sits behind a CDN that answers 520 on raw
 * non-ASCII header bytes), the device id is expected to be stable per install,
 * and the platform string names a client family rather than the host product.
 * Device-id persistence is deliberately best-effort — an unwritable agent dir
 * must degrade to a per-process id, never throw, because these headers are
 * built for every request.
 *
 * Subscription (OAuth) path only: the api-key path authenticates with a
 * platform key rather than a client session and stays header-free.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { getProviderEnvValue } from "../../utils/provider-env.ts";

const KIMI_CLIENT_PLATFORM = "kimi_cli";
const KIMI_CLIENT_VERSION = "1.0";
const DEVICE_ID_FILENAME = "kimi-device-id";

function sanitizeHeaderValue(value: string, fallback = "unknown"): string {
	const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
	return sanitized || fallback;
}

function agentDir(): string {
	const configured = getProviderEnvValue("SENPI_CODING_AGENT_DIR") ?? getProviderEnvValue("CODING_AGENT_DIR");
	if (configured) return configured.replace(/\/$/, "");
	const home = getProviderEnvValue("HOME") ?? ".";
	return `${home.replace(/\/$/, "")}/.senpi/agent`;
}

function deviceModel(): string {
	const current = platform();
	const label =
		current === "darwin" ? "macOS" : current === "win32" ? "Windows" : current === "linux" ? "Linux" : current;
	return [label, release(), arch()].filter(Boolean).join(" ").trim();
}

function readOrMintDeviceId(): string {
	const directory = agentDir();
	const path = join(directory, DEVICE_ID_FILENAME);
	try {
		const existing = readFileSync(path, "utf-8").trim();
		if (existing) return existing;
	} catch {
		// Absent or unreadable: fall through and mint a replacement.
	}

	const minted = randomUUID().replace(/-/g, "");
	try {
		mkdirSync(directory, { recursive: true });
		writeFileSync(path, `${minted}\n`, { mode: 0o600 });
	} catch {
		// Unwritable agent dir: this id lives for the current process only.
	}
	return minted;
}

let cachedDeviceId: string | undefined;

function deviceId(): string {
	cachedDeviceId ??= readOrMintDeviceId();
	return cachedDeviceId;
}

/** Test seam: forget the memoized id so a fresh agent dir is re-read. */
export function resetKimiDeviceIdForTests(): void {
	cachedDeviceId = undefined;
}

export function kimiCodeIdentityHeaders(): Record<string, string> {
	return {
		"User-Agent": `KimiCLI/${KIMI_CLIENT_VERSION}`,
		"X-Msh-Platform": KIMI_CLIENT_PLATFORM,
		"X-Msh-Version": KIMI_CLIENT_VERSION,
		"X-Msh-Device-Name": sanitizeHeaderValue(hostname()),
		"X-Msh-Device-Model": sanitizeHeaderValue(deviceModel()),
		"X-Msh-Os-Version": sanitizeHeaderValue(release()),
		"X-Msh-Device-Id": sanitizeHeaderValue(deviceId()),
	};
}
