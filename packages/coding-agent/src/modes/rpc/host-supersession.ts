/**
 * Noticing that this generation stopped owning its endpoint.
 *
 * A handoff ASKS the predecessor to drain (SIGUSR1), and that request can simply not arrive: an
 * owner whose registration cannot be proven is never signalled, a client that binds its own entry
 * over the path sends nothing at all, and a wedged process can miss the signal it was sent. The
 * generation is then unreachable - the public name resolves to somebody else's socket - while it
 * still holds every retained session and every session-path claim it ever published. That is how
 * one machine ended up with three supervisors on one endpoint, the superseded pair holding
 * gigabytes of sessions no client could reach (#1893).
 *
 * The evidence needs no cooperation from whoever replaced it: the entry at the public path is no
 * longer the socket this generation bound. That is checked here, on a slow unref'd timer, and it
 * fires exactly once - the caller's drain is not idempotent bookkeeping, it is a lifecycle
 * transition.
 *
 * A name that is GONE rather than taken over ends in the same place: a deleted workspace, a swept
 * temp directory or a stray `rm` leaves a generation that no client can resolve, holding its
 * sessions and path claims until the machine reboots (#1961, measured at 23h45m). Absence is
 * therefore a loss too, but a weaker observation than supersession - nobody is serving that name
 * to prove it - so it must be seen on several consecutive polls before it counts, and a stat that
 * cannot answer resets the count instead of adding to it.
 *
 * An endpoint with no file identity at all - a win32 named pipe has no inode to compare - is watched
 * through two positive observations instead (#3653): the pointer names ANOTHER instance, and the
 * public endpoint answers `get_protocol_info` as that same instance. Each is needed: a pointer can be
 * rewritten by an ensure that never came up, and an answer alone cannot tell a replacer from this
 * generation's own listener. They must agree on several consecutive polls, and every other
 * observation - no pointer, an unanswered probe, an answer as this generation or as a third
 * instance - resets the count. Such an endpoint is never judged absent: with nothing to stat,
 * "nobody answered" is indistinguishable from "busy", and a probe that failed once must never be what
 * drains a generation. Nothing here removes or reclaims state either way; a loss only starts a drain.
 */
import { readFile } from "node:fs/promises";
import { OBSERVE_REQUEST_FIELD } from "./host-observe-request.ts";
import { classifyEndpointOwnership, type SocketFileIdentity } from "./socket-ownership.ts";

/** How often a generation re-checks that the public path still holds the socket it bound. */
export const SUPERSESSION_POLL_MS = 1_000;

/** Consecutive absent observations before a missing entry counts as gone rather than as a race. */
export const ABSENT_CONFIRMATIONS = 3;

/** Consecutive agreeing pointer + endpoint observations before an identity-less endpoint counts as replaced. */
export const REPLACED_CONFIRMATIONS = 3;

/** Bound on one identity probe of the public endpoint; an unanswered probe is no evidence. */
const IDENTITY_PROBE_TIMEOUT_MS = 2_000;

/** How a generation stopped owning its endpoint: somebody took the name, or the name is gone. */
export type EndpointLoss = "replaced" | "absent";

export interface SupersededEndpoint {
	/** The public path this generation serves: the supervisor's, not a private internal hop. */
	readonly path: string;
	/** The entry it bound there. Without one, supersession can never be proven and is never claimed. */
	readonly identity: SocketFileIdentity | undefined;
	/** Consulted every tick; a host already draining or shutting down has nothing left to notice. */
	readonly settled?: () => boolean;
	/** The daemon pointer and this generation's instance id: the evidence used when `identity` is absent. */
	readonly pointer?: SupersessionPointer;
	/** Which instance answers at `path`; injectable for tests. Defaults to an `observe` read. */
	readonly probeInstanceId?: (path: string) => Promise<string | undefined>;
	/** Which instance the pointer names; injectable for tests. Defaults to reading `pointer.file`. */
	readonly readPointerInstanceId?: (file: string) => Promise<string | undefined>;
}

export interface SupersessionPointer {
	readonly file: string;
	readonly instanceId: string;
}

/** Runs `onLost` once this endpoint stops being served by the entry this generation bound. */
export function watchForSupersession(endpoint: SupersededEndpoint, onLost: (loss: EndpointLoss) => void): () => void {
	if (endpoint.identity === undefined) {
		return endpoint.pointer === undefined ? () => {} : watchPointerSupersession(endpoint, endpoint.pointer, onLost);
	}
	let absentPolls = 0;
	let lost = false;
	// Clearing the interval cannot unsend the classifications already in flight, so the transition
	// latches here: several pending observations of one loss still deliver a single drain request.
	const lose = (loss: EndpointLoss): void => {
		if (lost) return;
		lost = true;
		stop();
		onLost(loss);
	};
	const timer = setInterval(() => {
		if (endpoint.settled?.() === true) return;
		void classifyEndpointOwnership(endpoint.path, endpoint.identity).then((ownership) => {
			if (endpoint.settled?.() === true) return;
			switch (ownership) {
				case "replaced":
					lose("replaced");
					return;
				case "absent":
					absentPolls += 1;
					if (absentPolls < ABSENT_CONFIRMATIONS) return;
					lose("absent");
					return;
				case "held":
				case "unknown":
					absentPolls = 0;
					return;
			}
		}, ignore);
	}, SUPERSESSION_POLL_MS);
	// Unref'd: noticing a supersession must never be the reason a process stays up.
	timer.unref?.();
	const stop = (): void => clearInterval(timer);
	return stop;
}

function watchPointerSupersession(
	endpoint: SupersededEndpoint,
	pointer: SupersessionPointer,
	onLost: (loss: EndpointLoss) => void,
): () => void {
	const probe = endpoint.probeInstanceId ?? probeAnsweringInstance;
	const readPointer = endpoint.readPointerInstanceId ?? pointerInstanceId;
	let agreeingPolls = 0;
	let observing = false;
	let lost = false;
	const observe = async (): Promise<boolean> => {
		const named = await readPointer(pointer.file);
		if (named === undefined || named === pointer.instanceId) return false;
		return (await probe(endpoint.path)) === named;
	};
	const timer = setInterval(() => {
		if (lost || observing || endpoint.settled?.() === true) return;
		observing = true;
		void observe()
			.then(
				(replaced) => {
					if (lost || endpoint.settled?.() === true) return;
					agreeingPolls = replaced ? agreeingPolls + 1 : 0;
					if (agreeingPolls < REPLACED_CONFIRMATIONS) return;
					lost = true;
					clearInterval(timer);
					onLost("replaced");
				},
				() => {
					agreeingPolls = 0;
				},
			)
			.finally(() => {
				observing = false;
			});
	}, SUPERSESSION_POLL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

async function pointerInstanceId(file: string): Promise<string | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		const instanceId = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "instance_id") : undefined;
		return typeof instanceId === "string" && instanceId !== "" ? instanceId : undefined;
	} catch {
		return undefined;
	}
}

async function probeAnsweringInstance(path: string): Promise<string | undefined> {
	// Loaded on first use, and only by an endpoint with no file identity (a win32 named pipe) whose pointer already
	// names another instance: the socket client is not part of the supervisor's startup graph, which has a module
	// budget (test/supervisor-import-graph.test.ts). The raw answer is read, not the parsed protocol info, whose
	// parser would pull the build-id reader in as well.
	const { isRecord, requestOnSocket } = await import("./host-socket-request.ts");
	const answer = await requestOnSocket(
		path,
		{ type: "get_protocol_info", [OBSERVE_REQUEST_FIELD]: true },
		IDENTITY_PROBE_TIMEOUT_MS,
	).catch(() => undefined);
	return isRecord(answer) && typeof answer.instanceId === "string" ? answer.instanceId : undefined;
}

function ignore(): void {}
