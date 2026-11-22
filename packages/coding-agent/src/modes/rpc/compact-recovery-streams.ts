import type { RecoveryRoute } from "./compact-recovery-state.ts";
import type { RecoveryCaller, RecoveryStreamState } from "./compact-recovery-types.ts";

/**
 * One peer + session stream (RULING-42 Q2 A): the session incarnation it materializes, its issued generation,
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
	readonly socketEpoch: string;
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
	/** Per peer incarnation, each routed admission and how many of its streams route it (a mirror routes several). */
	private readonly routed = new Map<string, Map<string, number>>();

	get size(): number {
		return this.streams.size;
	}

	get(caller: RecoveryCaller): RecoveryStreamRecord | undefined {
		return this.streams.get(keyOf(caller));
	}

	/** Another ordinary hold joins the installed cut without advancing its generation. */
	join(route: RecoveryRoute): void {
		const stream = this.streams.get(keyOf(route));
		if (stream) this.addRoute(stream, route.admissionId);
	}

	/** Whether any stream of the peer incarnation routes the admission (#5274), without walking its sessions. */
	routes(socketEpoch: string, admissionId: string): boolean {
		return this.routed.get(socketEpoch)?.has(admissionId) === true;
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
	 * the record (carry 37). RULING-99 supplies the session-owned generation; returns the previous current token.
	 */
	next(route: RecoveryRoute, sessionEpoch: string, tokenId: string, generation: number): { retired?: string } {
		const key = keyOf(route);
		const existing = this.streams.get(key);
		if (existing && existing.sessionEpoch !== sessionEpoch) this.drop(key, existing);
		const stream: RecoveryStream =
			existing?.sessionEpoch === sessionEpoch
				? existing
				: {
						socketEpoch: route.socketEpoch,
						sessionId: route.sessionId,
						sessionEpoch,
						generation,
						routes: new Set(),
						current: undefined,
					};
		this.streams.set(key, stream);
		stream.generation = generation;
		this.addRoute(stream, route.admissionId);
		const retired = existing?.current;
		stream.current = tokenId;
		return retired === undefined ? {} : { retired };
	}

	forgetPeer(socketEpoch: string): void {
		for (const [key, stream] of this.streams) if (stream.socketEpoch === socketEpoch) this.drop(key, stream);
	}

	/** The routing session ended for good: its record goes on every peer (a sealed handle is never re-attached). */
	forgetSession(sessionId: string): void {
		for (const [key, stream] of this.streams) if (stream.sessionId === sessionId) this.drop(key, stream);
	}

	/** An admission ended (a detach today; S14 extends this): its route leaves the stream, the counter stays. */
	retireRoute(caller: RecoveryCaller, admissionId: string): void {
		const stream = this.streams.get(keyOf(caller));
		if (stream) this.removeRoute(stream, admissionId);
	}

	private addRoute(stream: RecoveryStream, admissionId: string): void {
		if (stream.routes.has(admissionId)) return;
		stream.routes.add(admissionId);
		const routed = this.routed.get(stream.socketEpoch) ?? new Map<string, number>();
		routed.set(admissionId, (routed.get(admissionId) ?? 0) + 1);
		this.routed.set(stream.socketEpoch, routed);
	}

	private removeRoute(stream: RecoveryStream, admissionId: string): void {
		if (!stream.routes.delete(admissionId)) return;
		const routed = this.routed.get(stream.socketEpoch);
		const remaining = (routed?.get(admissionId) ?? 1) - 1;
		if (remaining > 0) routed?.set(admissionId, remaining);
		else routed?.delete(admissionId);
		if (routed?.size === 0) this.routed.delete(stream.socketEpoch);
	}

	private drop(key: string, stream: RecoveryStream): void {
		for (const admissionId of [...stream.routes]) this.removeRoute(stream, admissionId);
		this.streams.delete(key);
	}
}
