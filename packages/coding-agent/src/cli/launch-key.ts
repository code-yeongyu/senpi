import type { Duplex } from "node:stream";
import {
	privateChannelAdoptable,
	privateChannelOffered,
	privateFdTableUnparseable,
	takeInheritedPrivateChannel,
} from "../private-fds.ts";

/** Offered, or possibly offered: a table that was present and could not be read may have named the key. */
function keyMayBeOffered(name: string): boolean {
	return privateChannelOffered(name) || privateFdTableUnparseable();
}

/** The private descriptor a launch function delivers a provider key on (security design 5.5, launch row). */
export const LAUNCH_KEY_CHANNEL = "api-key";
/** The whole key step, read and close, must end within this; otherwise the engine fails closed before it starts. */
export const LAUNCH_KEY_DEADLINE_MS = 10_000;
/** The exit code of an engine that refused its launch key; a launch reads it as `launch_key_failed`. */
export const LAUNCH_KEY_FAILED_EXIT_CODE = 78;
const MAX_KEY_BYTES = 64 * 1024;

/** The closed set an engine names a refused launch key by, in its `Error: <code>: ...` line. */
export const LAUNCH_KEY_FAILURES = ["launch_key_unreadable", "launch_key_too_large", "launch_key_timeout"] as const;
export type LaunchKeyFailure = (typeof LAUNCH_KEY_FAILURES)[number];

export class LaunchKeyError extends Error {
	readonly code: LaunchKeyFailure;

	constructor(code: LaunchKeyFailure, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Destroys the channel and waits for its `close`, which follows the descriptor's own close. Under Bun the destroy
 * of an inherited stream emits an AbortError; it belongs to this close, not to the read, so it is not raised.
 */
function closeChannel(channel: Duplex): Promise<void> {
	if (channel.closed) return Promise.resolve();
	return new Promise((resolve) => {
		channel.on("error", () => {});
		channel.once("close", () => resolve());
		channel.destroy();
	});
}

async function readAndClose(channel: Duplex): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of channel) {
			const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += bytes.length;
			if (size > MAX_KEY_BYTES) {
				throw new LaunchKeyError(
					"launch_key_too_large",
					`the key on channel ${LAUNCH_KEY_CHANNEL} is larger than a provider key can be`,
				);
			}
			chunks.push(bytes);
		}
	} catch (error: unknown) {
		if (error instanceof LaunchKeyError) throw error;
		throw new LaunchKeyError("launch_key_unreadable", `the key on channel ${LAUNCH_KEY_CHANNEL} could not be read`);
	} finally {
		await closeChannel(channel);
	}
	const key = Buffer.concat(chunks)
		.toString("utf8")
		.replace(/\r?\n$/u, "");
	if (key.length === 0) {
		throw new LaunchKeyError("launch_key_unreadable", `channel ${LAUNCH_KEY_CHANNEL} delivered an empty key`);
	}
	return key;
}

/**
 * Reads the launch key once and closes its descriptor before answering: `destroy()` only schedules the close, so
 * it waits for the channel's `close` event, and nothing this engine starts after the call can inherit it. The read
 * and the close together are bounded by `LAUNCH_KEY_DEADLINE_MS`: past it the step fails closed with
 * `launch_key_timeout` and the key is never used. Answers undefined when no launch delivered one, when an earlier
 * hop took it (declared `null`), and on every call after the first. A channel that was offered a descriptor but
 * cannot be adopted, read or delivers an empty key fails with `launch_key_unreadable` before any credential is
 * chosen, so the engine never falls back to another credential in silence. A failure names the channel, never the
 * bytes read.
 */
export async function readLaunchKey(
	takeChannel: (name: string) => Duplex | undefined = takeInheritedPrivateChannel,
	offered: (name: string) => boolean = keyMayBeOffered,
): Promise<string | undefined> {
	const wasOffered = offered(LAUNCH_KEY_CHANNEL);
	const channel = takeChannel(LAUNCH_KEY_CHANNEL);
	if (channel === undefined) {
		if (!wasOffered) return undefined;
		throw new LaunchKeyError(
			"launch_key_unreadable",
			`channel ${LAUNCH_KEY_CHANNEL} was given a descriptor this engine could not adopt`,
		);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			channel.destroy();
			reject(
				new LaunchKeyError(
					"launch_key_timeout",
					`the key on channel ${LAUNCH_KEY_CHANNEL} was not read and closed within ${LAUNCH_KEY_DEADLINE_MS / 1000} s`,
				),
			);
		}, LAUNCH_KEY_DEADLINE_MS);
	});
	try {
		return await Promise.race([readAndClose(channel), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The entry's guard before any hop. Forwarding a refused descriptor writes `null`, which the next process reads as
 * "taken upstream, no key here": only the process that refused it can tell the two apart, so it fails closed here,
 * before the re-exec under Bun or the isolated child, with the same code and exit `main()` uses.
 */
export function refuseUnusableLaunchKey(
	offered: (name: string) => boolean = keyMayBeOffered,
	adoptable: (name: string) => boolean = privateChannelAdoptable,
	exit: (code: number) => never = process.exit,
): void {
	if (!offered(LAUNCH_KEY_CHANNEL) || adoptable(LAUNCH_KEY_CHANNEL)) return;
	process.stderr.write(
		`Error: launch_key_unreadable: channel ${LAUNCH_KEY_CHANNEL} cannot be adopted (its descriptor was refused or the private table could not be read)\n`,
	);
	exit(LAUNCH_KEY_FAILED_EXIT_CODE);
}
