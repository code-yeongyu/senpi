/**
 * The supervisor-to-host lifetime binding (senpi#3816 round 7): supervisor death, for any cause, reaches its POSIX host
 * as an event. Every platform choice lives here; callers never branch on the platform.
 * - Linux: a FIFO, mode 0600, in the supervisor's private 0700 hop directory. The supervisor creates it (one mkfifo;
 *   Node and Bun have no call for it) and opens the only writer O_RDWR before it spawns the host, close-on-exec so no
 *   descendant inherits it; the host reads it non-blocking, and EOF arrives when the kernel closes that writer.
 * - macOS: the host's reopened stdin (the key pipe). libuv reports no EOF for a FIFO there (measured on Node and Bun).
 * - Windows: none here; the inherited lifetime pipe is unchanged.
 * A stale FIFO only lives in a crashed start's hop directory, which the internal-directory reaper removes; clean
 * shutdown removes the hop directory with it.
 */
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { watchHostLifetime } from "./host-lifetime-reader.ts";

/** The FIFO path the supervisor passes to its host. */
export const HOST_WATCH_LIFETIME_FIFO_ENV = "SENPI_RPC_HOST_LIFETIME_FIFO";

export interface LifetimeBinding {
	/** Linux: the supervisor's lifetime FIFO. */
	readonly lifetimeFifo?: string;
	/** macOS: the reopened stdin descriptor from the host's stdin bootstrap. */
	readonly lifetimeFd?: number;
}

/** Supervisor side: creates this platform's binding in the private hop directory; what the host must be told. */
export function prepareLifetimeBinding(hopDir: string, platform: NodeJS.Platform = process.platform): LifetimeBinding {
	if (platform !== "linux") return {};
	const path = join(hopDir, "lifetime.fifo");
	try {
		rmSync(path, { force: true });
		execFileSync("mkfifo", ["-m", "600", path], { stdio: "ignore" });
		// Held, never closed: the supervisor's death is what closes it.
		openSync(path, constants.O_RDWR);
		return { lifetimeFifo: path };
	} catch {
		// Without it the host keeps the recorded-identity poll.
		return {};
	}
}

/**
 * Host side: arms this platform's binding. `gone` receives the reason when the supervisor is gone; `unavailable` when
 * the binding fails later. Returns its disarm, or undefined when the platform or launch provides none.
 */
export function armLifetimeBinding(
	binding: LifetimeBinding,
	gone: (reason: string) => void,
	unavailable: () => void,
	platform: NodeJS.Platform = process.platform,
): (() => void) | undefined {
	if (platform === "win32") return undefined;
	const fifo = platform === "linux" ? openFifoReadEnd(binding.lifetimeFifo) : undefined;
	if (fifo !== undefined) {
		if (binding.lifetimeFd !== undefined) closeSync(binding.lifetimeFd);
		return watchHostLifetime(fifo, () => gone("supervisor lifetime FIFO closed"), unavailable);
	}
	if (binding.lifetimeFd === undefined) return undefined;
	return watchHostLifetime(binding.lifetimeFd, () => gone("supervisor stdin lifetime closed"), unavailable);
}

/** O_NONBLOCK returns at once with or without a writer, so the host's event loop never blocks on the open. */
function openFifoReadEnd(path: string | undefined): number | undefined {
	if (path === undefined) return undefined;
	let fd: number;
	try {
		// O_NOFOLLOW: a symlink at the path is refused, never followed (senpi#3816 review).
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch {
		return undefined;
	}
	// Only this user's own 0600 FIFO is the binding; anything else (a regular file reads EOF at once) is refused.
	const stat = fstatSync(fd);
	const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
	if (stat.isFIFO() && owned && (stat.mode & 0o777) === 0o600) return fd;
	closeSync(fd);
	return undefined;
}
