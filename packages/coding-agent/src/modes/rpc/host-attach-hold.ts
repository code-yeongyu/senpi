/**
 * The ensuring client's claim on a host between `ensureHost()` proving it ready and that client's
 * own attach. It is the very connection the readiness answer arrived on, kept open, so the
 * supervisor counts it as an attachment and never measures idle time across the gap: a transient
 * host with a short idle window cannot exit before the client that asked for it has attached.
 *
 * The claim ends when the caller releases it, and the operating system ends it when the ensuring
 * process dies, so an abandoned ensure never pins a host. It never keeps its own process alive.
 */
import type { Socket } from "node:net";

export interface HostAttachHold {
	/** Ends the claim. Idempotent; call it once the client's own connection is attached. */
	release(): void;
}

export function holdAttachment(socket: Socket): HostAttachHold {
	// A host broadcasts lifecycle records to every connection; drain them so the pipe never backs up.
	socket.removeAllListeners("data");
	socket.resume();
	socket.on("error", () => socket.destroy());
	socket.unref();
	return { release: () => socket.destroy() };
}
