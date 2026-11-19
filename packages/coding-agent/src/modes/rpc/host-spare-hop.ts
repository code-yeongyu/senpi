/**
 * One spare, already-authenticated engine hop the supervisor keeps for the next public client (senpi#7055).
 *
 * A client's handshake used to wait for the supervisor to open and authenticate a fresh hop to the engine (two engine
 * loop turns) before its challenge could even be forwarded (a third). On a busy engine each turn can take a second,
 * so the client's 2 s handshake budget expired. With a spare, only the forwarded challenge needs an engine turn.
 *
 * - The engine still authenticates every hop: a spare is opened through the same internal handshake as before.
 * - A spare classifies itself as an observer on the engine with one observing `get_protocol_info`, so it is never
 *   occupancy or an unclassified connection there, and it holds no attachment, seat or session.
 * - Records the engine sends while the spare idles (broadcasts) are discarded, so its client sees only what arrives
 *   after it took the hop, as with a hop opened for it. A spare caught mid-record is discarded instead of handed out.
 * - A spare goes to exactly one client and is never returned: its client's disconnect closes it.
 * - Exactly one spare exists; the refill runs on the supervisor's timer, off the client's path, and a failing refill
 *   backs off and gives up after a bounded number of attempts, so a dead engine is never retried in a hot loop.
 */
import type { Duplex } from "node:stream";
import type { Schedule } from "./socket-transport.ts";

const SPARE_PROBE_ID = "internal-spare";
/** Refill delays after consecutive failures, after the first immediate attempt; the refill then gives up. */
const SPARE_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

interface ReadySpare {
	readonly hop: Duplex;
	/** Stops the idle discard; false when the hop holds a partial record a client must never see. */
	handOver(): boolean;
}

export class SpareHop {
	private spare: Promise<ReadySpare | undefined> | undefined;
	private cancelRefill: (() => void) | undefined;
	private failures = 0;
	private disposed = false;
	private readonly open: () => Promise<Duplex>;
	private readonly schedule: Schedule;

	constructor(open: () => Promise<Duplex>, schedule: Schedule) {
		this.open = open;
		this.schedule = schedule;
	}

	/** The spare, ready or still opening, for one client; `undefined` sends the client down its own hop as before. */
	async take(): Promise<Duplex | undefined> {
		const spare = this.spare;
		this.spare = undefined;
		if (this.cancelRefill === undefined && this.failures > SPARE_RETRY_DELAYS_MS.length) this.failures = 0;
		this.arm(0);
		const ready = await spare;
		if (!ready) return undefined;
		if (ready.hop.destroyed || !ready.handOver()) {
			ready.hop.destroy();
			return undefined;
		}
		this.failures = 0;
		return ready.hop;
	}

	dispose(): void {
		this.disposed = true;
		this.cancelRefill?.();
		const spare = this.spare;
		this.spare = undefined;
		void spare?.then((ready) => ready?.hop.destroy());
	}

	private arm(delayMs: number): void {
		if (this.disposed || this.cancelRefill) return;
		this.cancelRefill = this.schedule(delayMs, () => {
			this.cancelRefill = undefined;
			if (this.disposed || this.spare) return;
			const spare: Promise<ReadySpare | undefined> = this.openSpare(() => this.lost(spare));
			this.spare = spare;
			void spare.then((ready) => {
				if (!ready) this.lost(spare);
			});
		});
	}

	private lost(spare: Promise<ReadySpare | undefined>): void {
		if (this.spare === spare) this.spare = undefined;
		const delay = SPARE_RETRY_DELAYS_MS[this.failures];
		this.failures++;
		if (delay !== undefined) this.arm(delay);
	}

	private async openSpare(lostWhileIdle: () => void): Promise<ReadySpare | undefined> {
		let hop: Duplex;
		try {
			hop = await this.open();
		} catch {
			return undefined;
		}
		if (this.disposed) {
			hop.destroy();
			return undefined;
		}
		let answered: (ready: boolean) => void = () => {};
		const probed = new Promise<boolean>((resolve) => (answered = resolve));
		let partial = "";
		let probeSeen = false;
		const idle = (chunk: Buffer): void => {
			const lines = (partial + chunk.toString("utf8")).split("\n");
			partial = lines.pop() ?? "";
			if (!probeSeen && lines.some((line) => line.includes(`"id":"${SPARE_PROBE_ID}"`))) {
				probeSeen = true;
				answered(true);
			}
		};
		const closed = (): void => {
			answered(false);
			if (probeSeen) lostWhileIdle();
		};
		const failed = (): void => {
			hop.destroy();
		};
		hop.on("data", idle);
		hop.once("close", closed);
		hop.on("error", failed);
		hop.write(`${JSON.stringify({ id: SPARE_PROBE_ID, type: "get_protocol_info", observe: true })}\n`);
		if (!(await probed)) {
			hop.destroy();
			return undefined;
		}
		return {
			hop,
			handOver: () => {
				hop.pause();
				hop.off("data", idle);
				hop.off("close", closed);
				hop.off("error", failed);
				return partial === "";
			},
		};
	}
}
