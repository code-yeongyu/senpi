import type { RecoveryRoute } from "./compact-recovery-state.ts";
import type { RecoveryCaller, RecoveryStreamState } from "./compact-recovery-types.ts";

/**
 * One peer + session stream (RULING-42 Q2 A): the session incarnation it materializes, S08a's generation counter,
 * the admissions routed through it (RULING-46 item 1) and its current token. It lives while both its peer
 * incarnation and its routing session do (RULING-56 (2)).
 */
export interface RecoveryStreamRecord {
	readonly sessionId: string;
	readonly sessionEpoch: string;
	readonly generation: number;
	readonly routes: ReadonlySet<string>;
	readonly current: string | undefined;
}

interface RecoveryStream extends RecoveryStreamRecord {
	sessionEpoch: string;
	generation: number;
	readonly routes: Set<string>;
	current: string | undefined;
}

const keyOf = ({ socketEpoch, sessionId }: RecoveryCaller): string => `${socketEpoch}\u0000${sessionId}`;

/**
 * The stream records of one host: one per peer incarnation and routing session, replaced by a new session
 * incarnation, freed when the peer incarnation or the routing session ends.
 */
export class RecoveryStreams {
	private readonly streams = new Map<string, RecoveryStream>();

	get size(): number {
		return this.streams.size;
	}

	get(caller: RecoveryCaller): RecoveryStreamRecord | undefined {
		return this.streams.get(keyOf(caller));
	}

	/** The bounded description a caller may hold: undefined once its peer incarnation or its session ended. */
	describe(caller: RecoveryCaller): RecoveryStreamState | undefined {
		const stream = this.get(caller);
		if (!stream) return undefined;
		const { sessionEpoch, generation } = stream;
		return { sessionEpoch, generation, routes: [...stream.routes] };
	}

	/**
	 * Admits the route's token as the stream's next generation at `sessionEpoch`; a new session incarnation replaces
	 * the record (carry 37). Returns the generation and the token this issuance retires: the previous current one.
	 */
	next(route: RecoveryRoute, sessionEpoch: string, tokenId: string): { generation: number; retired?: string } {
		const key = keyOf(route);
		const existing = this.streams.get(key);
		const stream: RecoveryStream =
			existing?.sessionEpoch === sessionEpoch
				? existing
				: {
						sessionId: route.sessionId,
						sessionEpoch,
						generation: 0,
						routes: new Set(),
						current: undefined,
					};
		this.streams.set(key, stream);
		stream.generation += 1;
		stream.routes.add(route.admissionId);
		const retired = existing?.current;
		stream.current = tokenId;
		return retired === undefined ? { generation: stream.generation } : { generation: stream.generation, retired };
	}

	forgetPeer(socketEpoch: string): void {
		for (const key of this.streams.keys()) if (key.startsWith(`${socketEpoch}\u0000`)) this.streams.delete(key);
	}

	/** The routing session ended for good: its record goes on every peer (a sealed handle is never re-attached). */
	forgetSession(sessionId: string): void {
		for (const [key, stream] of this.streams) if (stream.sessionId === sessionId) this.streams.delete(key);
	}

	/** An admission ended (a detach today; S14 extends this): its route leaves the stream, the counter stays. */
	retireRoute(caller: RecoveryCaller, admissionId: string): void {
		this.streams.get(keyOf(caller))?.routes.delete(admissionId);
	}
}
