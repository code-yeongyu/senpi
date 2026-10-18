import type { SessionPathOwner, SessionPathReservations } from "./host-reservations.ts";
import { RpcSessionRegistryError } from "./session-registry-types.ts";

type Claim = { ownership: Promise<SessionPathOwner | undefined>; attached: boolean };

/** Claims precede write grants; native exit also removes claims whose publication is still pending. */
export class WorkerSessionClaims {
	private readonly reservations: SessionPathReservations | undefined;
	private readonly paths = new Map<string, Claim>();
	private readonly releases = new Set<Promise<void>>();
	private closed = false;

	constructor(reservations: SessionPathReservations | undefined) {
		this.reservations = reservations;
	}

	async claim(path: string, attached = true): Promise<SessionPathOwner | undefined> {
		if (this.closed) throw new RpcSessionRegistryError("session_closing");
		if (!this.reservations) return undefined;
		const previous = this.paths.get(path);
		if (previous) return previous.ownership;
		const record: Claim = { ownership: this.reservations.claim(path, attached), attached };
		this.paths.set(path, record);
		const owner = await record.ownership;
		if (owner && this.paths.get(path) === record) this.paths.delete(path);
		return owner;
	}

	setAttached(attached: boolean): void {
		for (const [path, record] of this.paths) {
			if (record.attached === attached) continue;
			record.attached = attached;
			void record.ownership.then((owner) => {
				if (!owner && this.paths.get(path) === record) this.reservations?.setAttached(path, record.attached);
			});
		}
	}

	reconcile(livePaths: readonly string[], attached: boolean): void {
		const live = new Set(livePaths);
		for (const path of this.paths.keys()) if (!live.has(path)) void this.release(path);
		this.setAttached(attached);
	}

	private release(path: string): Promise<void> {
		const record = this.paths.get(path);
		if (!record) return Promise.resolve();
		this.paths.delete(path);
		const removal = record.ownership.then(async (owner) => {
			if (!owner) await this.reservations?.release(path);
		});
		this.releases.add(removal);
		void removal.then(
			() => this.releases.delete(removal),
			() => this.releases.delete(removal),
		);
		return removal;
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.paths.keys()].map((path) => this.release(path)).concat([...this.releases]));
	}
}
