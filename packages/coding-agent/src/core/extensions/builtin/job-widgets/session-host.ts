/**
 * The process-wide home of every session's job-widget registry, and the public API hosts use: the
 * terminal registers its background sessions here, omo registers task jobs and its cheap-model
 * route. A registry outlives one extension generation (a reload parks it and the next generation
 * re-binds it), so it is keyed by session id rather than held by an extension instance.
 */
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "../../types.ts";
import type { JobWidgetObfuscator } from "./author-redact.ts";
import type { JobWidgetAuthor } from "./author-types.ts";
import { JobWidgetRegistry, type JobWidgetSourceHandle } from "./registry.ts";
import type { JobWidgetJobInput } from "./registry-job.ts";
import type { JobWidgetState } from "./view-types.ts";

/** A host's route to the model that writes widget specs (omo: its `quick` category). */
export type JobWidgetHostModelResolver = (ctx: ExtensionContext) => Model<Api> | undefined;

export interface JobWidgetSourceRegistration extends JobWidgetJobInput {
	/** The agent session the job belongs to (`ctx.sessionManager.getSessionId()`). */
	readonly sessionId: string;
}

export interface JobWidgetSessionOptions {
	readonly authorAfterMs: number;
	readonly author: JobWidgetAuthor;
	readonly publish: (state: JobWidgetState) => void;
	readonly obfuscate?: JobWidgetObfuscator;
}

interface SessionSlot {
	readonly registry: JobWidgetRegistry;
	author: JobWidgetAuthor;
	/** Unset while the session's extension generation is parked across a reload. */
	publish: ((state: JobWidgetState) => void) | undefined;
}

/** A session's widgets started (`open`) or went away (`!open`); a re-bind after a reload is neither. */
export type JobWidgetSessionListener = (sessionId: string, open: boolean) => void;

const sessions = new Map<string, SessionSlot>();
const sessionListeners = new Set<JobWidgetSessionListener>();
let hostResolver: JobWidgetHostModelResolver | undefined;

/**
 * Hosts that keep jobs across a reload hear when a session's widgets start or stop: a stop leaves
 * their handles inert (drop them), a start after one is when to offer their running jobs again.
 */
export function onJobWidgetSessionChange(listener: JobWidgetSessionListener): () => void {
	sessionListeners.add(listener);
	return () => {
		sessionListeners.delete(listener);
	};
}

function notifySessionChange(sessionId: string, open: boolean): void {
	for (const listener of [...sessionListeners]) listener(sessionId, open);
}

/** Starts (or re-binds after a reload, with the settings read again) the job widgets of one session. */
export function openJobWidgetSession(sessionId: string, options: JobWidgetSessionOptions): void {
	const existing = sessions.get(sessionId);
	if (existing) {
		existing.author = options.author;
		existing.publish = options.publish;
		existing.registry.configure({
			limits: { authorAfterMs: options.authorAfterMs },
			...(options.obfuscate === undefined ? {} : { obfuscate: options.obfuscate }),
		});
		existing.registry.republish();
		return;
	}
	const slot: SessionSlot = {
		author: options.author,
		publish: options.publish,
		registry: new JobWidgetRegistry({
			sessionId,
			author: (request, signal) => slot.author(request, signal),
			publish: (state) => slot.publish?.(state),
			limits: { authorAfterMs: options.authorAfterMs },
			...(options.obfuscate === undefined ? {} : { obfuscate: options.obfuscate }),
		}),
	};
	sessions.set(sessionId, slot);
	notifySessionChange(sessionId, true);
}

/**
 * Sends the session's current state again for a listener that just subscribed (an RPC client that
 * declared `extension_events`), when there is a job to show; an empty state tells it nothing.
 */
export function resendJobWidgetState(sessionId: string): void {
	const registry = sessions.get(sessionId)?.registry;
	if (registry && registry.snapshot().jobs.length > 0) registry.republish();
}

/** Holds a session's state across a reload: jobs keep their taps, nothing is sent until re-bound. */
export function parkJobWidgetSession(sessionId: string): void {
	const slot = sessions.get(sessionId);
	if (slot) slot.publish = undefined;
}

export function closeJobWidgetSession(sessionId: string): void {
	const slot = sessions.get(sessionId);
	if (!slot) return;
	slot.registry.dispose();
	sessions.delete(sessionId);
	notifySessionChange(sessionId, false);
}

/**
 * Offers a job to the session's widgets. Returns `undefined` when the session has no widgets (the
 * setting is off, or the job-widgets extension is not loaded): the host then taps nothing.
 */
export function registerJobWidgetSource(registration: JobWidgetSourceRegistration): JobWidgetSourceHandle | undefined {
	const { sessionId, ...input } = registration;
	return sessions.get(sessionId)?.registry.add(input);
}

/** The session's current widget state (views redacted), or `undefined` when the session has no widgets. */
export function getJobWidgetState(sessionId: string): JobWidgetState | undefined {
	return sessions.get(sessionId)?.registry.state();
}

/**
 * Installs the host's model route for every session, ahead of the session's own model and behind an
 * explicit `jobWidgets.model` setting. Returns a function that removes it again (when still current).
 */
export function setJobWidgetAuthorResolver(resolver: JobWidgetHostModelResolver | undefined): () => void {
	hostResolver = resolver;
	return () => {
		if (hostResolver === resolver) hostResolver = undefined;
	};
}

export function jobWidgetHostResolver(): JobWidgetHostModelResolver | undefined {
	return hostResolver;
}
