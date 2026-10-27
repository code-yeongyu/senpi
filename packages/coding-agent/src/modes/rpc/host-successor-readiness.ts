/**
 * Watching a successor generation take the public socket. Split out of `host-successor.ts`, which launches the
 * successor and completes the handoff once this proves the publication.
 */
import type { HandoffRefusal } from "./host-handoff.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";
import { revokePublishToken } from "./host-publish-token.ts";
import { exitedWithin } from "./host-successor-abandon.ts";
import { type SocketFileIdentity, statSocketIdentity } from "./socket-ownership.ts";

/** How long a handoff whose readiness window closed follows a successor that had already taken its token. */
export const LATE_PUBLICATION_MS = 5_000;

/**
 * The successor's own answer on the PUBLIC socket is the only proof the rename landed: it
 * reports a different `instanceId` than the generation being replaced. An exit instead means
 * the successor refused to replace the path (a foreign socket, a live bind path) and left it alone.
 */
export async function awaitSuccessor(
	socket: string,
	previous: HostProtocolInfo,
	exited: Promise<void>,
	windowMs: number,
): Promise<HostProtocolInfo | undefined> {
	const deadline = Date.now() + windowMs;
	let childGone = false;
	void exited.then(() => {
		childGone = true;
	});
	while (Date.now() <= deadline) {
		const answer = await probeProtocolInfo(socket, 2_000);
		if (answer && answer.instanceId !== undefined && answer.instanceId !== previous.instanceId) return answer;
		if (childGone) return undefined;
		await delay(50);
	}
	return undefined;
}

/**
 * The readiness window closed (code-yeongyu/oh-my-openagent#10091). The publication is withdrawn first; a
 * successor that had already taken its token is followed for a bounded while instead of being stopped, because
 * it may own the public path now. `undefined`: it can no longer publish, or it exited after its rename failed,
 * so it is safe to stop. `unconfirmed`: it took the token, has not answered and is still running.
 */
export async function followWithdrawnPublication(
	publishToken: string,
	socket: string,
	previous: HostProtocolInfo,
	exited: Promise<void>,
): Promise<HostProtocolInfo | "unconfirmed" | undefined> {
	if ((await revokePublishToken(publishToken)) === "revoked") return undefined;
	const late = await awaitSuccessor(socket, previous, exited, LATE_PUBLICATION_MS);
	if (late !== undefined) return late;
	return (await exitedWithin(exited, 0)) ? undefined : "unconfirmed";
}

/**
 * What actually stopped the handoff, read from the endpoint rather than guessed: a public path
 * that no longer holds the socket this handoff was decided against was taken by somebody else,
 * and the successor correctly refused to rename over it.
 */
export async function abortReason(socket: string, replaced: SocketFileIdentity): Promise<HandoffRefusal> {
	const current = await statSocketIdentity(socket).catch(() => undefined);
	return current === undefined || current.dev !== replaced.dev || current.ino !== replaced.ino
		? "socket_replaced"
		: "successor_unavailable";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
