import type { Duplex } from "node:stream";
import { takeInheritedPrivateChannel } from "../private-fds.ts";

/** The private descriptor a launch function delivers a provider key on (security design 5.5, launch row). */
export const LAUNCH_KEY_CHANNEL = "api-key";
const MAX_KEY_BYTES = 64 * 1024;

export class LaunchKeyError extends Error {}

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

/**
 * Reads the launch key once and closes its descriptor before answering: `destroy()` only schedules the close, so
 * it waits for the channel's `close` event, and nothing this engine starts after the call can inherit it. Answers
 * undefined when no launch delivered one. A failure names the channel, never the bytes read.
 */
export async function readLaunchKey(
	takeChannel: (name: string) => Duplex | undefined = takeInheritedPrivateChannel,
): Promise<string | undefined> {
	const channel = takeChannel(LAUNCH_KEY_CHANNEL);
	if (channel === undefined) return undefined;
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of channel) {
			const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += bytes.length;
			if (size > MAX_KEY_BYTES) throw new LaunchKeyError("the launch key is larger than a provider key can be");
			chunks.push(bytes);
		}
	} catch (error: unknown) {
		if (error instanceof LaunchKeyError) throw error;
		throw new LaunchKeyError("the launch key could not be read");
	} finally {
		await closeChannel(channel);
	}
	const key = Buffer.concat(chunks)
		.toString("utf8")
		.replace(/\r?\n$/u, "");
	return key.length > 0 ? key : undefined;
}
