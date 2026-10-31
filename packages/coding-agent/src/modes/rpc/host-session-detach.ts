import { type RpcClient, RpcTransportGoneError } from "./rpc-client.ts";

export const DETACH_ACK_TIMEOUT_MS = 5_000;

/**
 * Before a short-lived `senpi host session` client closes, ask the host to drop its attachments and wait for
 * the answer, so the session no longer counts this client once the command returns (senpi#3238). An older
 * host without `detach_connection` keeps today's release on socket close. A host that does not answer within
 * the bound is reported in one plain line and the connection is closed anyway; the command's own outcome stands.
 */
export async function detachBeforeClose(
	client: RpcClient,
	report: (line: string) => void,
	timeoutMs = DETACH_ACK_TIMEOUT_MS,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<"late">((resolve) => {
		timer = setTimeout(() => resolve("late"), timeoutMs);
	});
	try {
		const outcome = await Promise.race([client.detachConnection(), late]);
		if (outcome === "late")
			report(`the host did not confirm the detach within ${timeoutMs} ms; closing the connection anyway`);
	} catch (error) {
		// A connection that is already gone holds nothing the host has not released on its close.
		if (error instanceof RpcTransportGoneError) return;
		report(
			`the host refused the detach (${error instanceof Error ? error.message : String(error)}); closing the connection anyway`,
		);
	} finally {
		clearTimeout(timer);
	}
}
