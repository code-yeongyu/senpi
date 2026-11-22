// senpi#7202: a successor reopening a session its draining predecessor still claims dials the predecessor's route
// endpoint. A predecessor that exits at that moment ends the connection inside the authentication handshake: a frame
// the successor already wrote is left unread (`read ECONNRESET`), or the successor's first write meets a closed peer
// (`write EPIPE`). Nothing was sent to it, so the route is gone, as it is for ENOENT and ECONNREFUSED. The open
// answered the raw socket error instead (`{"success":false,"error":"read ECONNRESET"}`), and a client reopening its
// parked session after a handover under load failed there. It now goes back to the local claim path, which opens the
// session once the exited predecessor's claim is gone.
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { type Cleanups, successorWithPredecessorClaim } from "../rpc-predecessor-route-support.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * How the exiting predecessor ends the successor's connection. It never reads (`pauseOnConnect`), then releases its
 * claim and closes: at once, before the successor's queued first frame is written (EPIPE), or a loop turn later, with
 * that frame unread in its receive queue (ECONNRESET on Linux).
 */
const EXITS: ReadonlyArray<readonly [string, (exit: () => void) => void]> = [
	["before the successor's first frame is written", (exit) => exit()],
	["with the successor's first frame unread", (exit) => setImmediate(exit)],
];

it.skipIf(process.platform === "win32").each(EXITS)(
	"an open routed to a predecessor that exits during the handshake %s opens locally",
	async (_shape, when) => {
		const host = await successorWithPredecessorClaim(cleanups);
		await host.predecessorHolds();
		const claim = reservationFile(join(host.daemonDir, "reservations"), host.heldPath);
		const socket = join(host.root, "route.sock");
		let dials = 0;
		const server = createServer({ pauseOnConnect: true }, (connection) => {
			dials += 1;
			when(() => {
				rmSync(claim, { force: true });
				connection.destroy();
			});
		});
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const generationDir = join(host.daemonDir, "generations", "pred");
		await mkdir(generationDir, { recursive: true, mode: 0o700 });
		await writeFile(join(generationDir, "route.json"), `${JSON.stringify({ socket, launchId: "pred-launch" })}\n`);

		const opened = await host.send({ type: "open_session", id: "reopen", sessionPath: host.heldPath });

		expect(dials, "the open never dialed the predecessor's route").toBe(1);
		expect(opened, JSON.stringify(opened)).toMatchObject({
			success: true,
			data: { state: { sessionFile: host.heldPath } },
		});
	},
);
