/**
 * The supervisor's private hop (senpi#3795): its path, the transport credentials the child, the activity observer and
 * the public proxy share (a Windows pipe secret, or a fresh memory-only POSIX key the child gets on stdin), and the
 * supervisor's own start time for the child's lifetime poll. Split out of host-lifecycle.ts.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readProcessStartTicks } from "../../utils/process-start-identity.ts";
import { createInternalSocketPath } from "./host-lifecycle-scratch.ts";
import { prepareLifetimeBinding } from "./host-lifetime-binding.ts";
import { createSocketSecret, socketSecretPath } from "./socket-transport.ts";

/** The start time the hop directory's owner record already holds, so it is read (spawned) once, not twice. */
async function recordedOwnerStartTime(dir: string | undefined): Promise<string | undefined> {
	if (dir === undefined) return undefined;
	try {
		const owner: unknown = JSON.parse(await readFile(join(dir, ".owner"), "utf8"));
		const start = owner !== null && typeof owner === "object" ? Reflect.get(owner, "processStartTime") : undefined;
		return typeof start === "string" ? start : undefined;
	} catch {
		// An unreadable record leaves the child's identity poll without a start time: unknown, never death.
		return undefined;
	}
}

export async function prepareInternalHop(daemonDir: string) {
	const created = await createInternalSocketPath(daemonDir);
	const internal = { ...created, secretPath: created.secretPath ?? socketSecretPath(created.socket) };
	const internalSecret = process.platform === "win32" ? await createSocketSecret(internal.secretPath) : undefined;
	const internalKey = process.platform === "win32" ? undefined : randomBytes(32);
	return {
		internal,
		internalSocket: internal.socket,
		internalSecret,
		internalKey,
		// The child compares these on one clock per platform: ps lstart off Linux, /proc start ticks on Linux.
		...(internalKey && internal.dir !== undefined ? prepareLifetimeBinding(internal.dir) : {}),
		supervisorStart: internalKey
			? { time: await recordedOwnerStartTime(internal.dir), ticks: readProcessStartTicks(process.pid) }
			: undefined,
		transport: { ...(internalSecret ? { internalSecret } : {}), ...(internalKey ? { internalKey } : {}) },
	};
}
