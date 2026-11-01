import type { CompactDialog } from "./compact-current-components.ts";
import type { RetainedRoot } from "./compact-recovery-state.ts";
import { type RecoveryOutcome, type RefusalReason, refusalReason } from "./compact-recovery-types.ts";
import type { ActiveBlockView, ActiveMessageView } from "./compact-state-view.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { GeneratedFramesCursor, type LegacyViewCursor } from "./legacy-view-cursor.ts";
import { omitNormalInlineMedia } from "./media-placeholders.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "./session-acceptance-lane.ts";

/**
 * A lane and the root it froze for one legacy view (R3.C1.5); absent when the lane had no readable root. Every read
 * of `root` runs inside `hold`, as an operation in flight on the root's checkpoint, so a reclaim (a supersession, a
 * retired route, the peer's end) waits for it instead of releasing the root under it.
 */
export interface LegacyViewSource {
	readonly lane: SessionAcceptanceLane;
	readonly root: FrozenAcceptedRoot;
	hold<T>(read: () => Promise<T>): Promise<T>;
}

/**
 * Which refused cuts the resync reports on stderr: only a store that could not serve the cut. Every repair reason is
 * the consumer's to repair, and a new reason must be classified here before it compiles.
 */
const REPORTED = {
	storage_unavailable: true,
	unknown_token: false,
	released: false,
	lane_retired: false,
	stale_epoch: false,
	peer_gone: false,
	session_closed: false,
	superseded_token: false,
} as const satisfies Record<RefusalReason, boolean>;

export interface LegacyAttachView {
	readonly placeholders: boolean;
	readonly now: number;
}

type Frame = Readonly<Record<string, unknown>>;

const isFrame = (value: unknown): value is Frame =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function unavailable(sessionId: string, cause: unknown): void {
	const reason = cause instanceof Error ? cause.message : String(cause);
	process.stderr.write(`senpi rpc legacy view: session ${sessionId} current view unavailable: ${reason}\n`);
}

/**
 * A block as a legacy consumer sees it at the cut (`current`), or as the message start laid it out (`start`): a
 * streamed text or thinking body starts empty, a block the start carried whole keeps its value.
 */
function blockValue(block: ActiveBlockView, layout: "current" | "start"): unknown {
	const value = block.block ?? {};
	if (layout === "current" || block.phase === "initial" || block.phase === undefined) return value;
	if ("text" in value) return { ...value, text: "" };
	if ("thinking" in value) return { ...value, thinking: "" };
	return value;
}

/** The legacy message: `role`, then `content` from the current blocks, then the accepted metadata at the cut. */
function legacyMessage(message: ActiveMessageView, layout: "current" | "start"): Frame | undefined {
	const fields = message.fields;
	if (!fields) return undefined;
	if ("content" in fields) return fields;
	const { role, ...rest } = fields;
	const content: unknown[] = [];
	for (const block of message.blocks) content[block.contentIndex] = blockValue(block, layout);
	return { ...(role === undefined ? {} : { role }), content, ...rest };
}

/** Per content index of one message, the resolved tool name its call kept at the cut. */
type ResolvedNames = ReadonlyMap<number, string>;

/**
 * The frames that rebuild one streamed block: its start, one delta carrying the whole current prefix, and its
 * end only when the block had already ended at the cut (design section 4). A block the start carried whole
 * (`initial`) needs no frame. A tool call's start and end carry its resolved name as the live frames do.
 */
function* blockFrames(
	{ contentIndex, text, phase, block }: ActiveBlockView,
	usage: unknown,
	resolved: ResolvedNames,
): Generator<Frame> {
	if (phase === undefined || phase === "initial" || block === undefined) return;
	const ended = phase === "ended";
	const resolvedToolName = resolved.get(contentIndex);
	const update = (assistantMessageEvent: Frame, named = false): Frame => ({
		type: "message_update",
		...(usage === undefined ? {} : { usage }),
		assistantMessageEvent,
		...(named && resolvedToolName !== undefined ? { resolvedToolName } : {}),
	});
	switch (block.type) {
		case "text":
		case "thinking": {
			yield update({ type: `${block.type}_start`, contentIndex });
			if (text.length > 0) yield update({ type: `${block.type}_delta`, contentIndex, delta: text });
			if (ended) yield update({ type: `${block.type}_end`, contentIndex, content: text });
			return;
		}
		case "toolCall": {
			yield update({ type: "toolcall_start", contentIndex, id: block.id, toolName: block.name }, true);
			if (text.length > 0) yield update({ type: "toolcall_delta", contentIndex, delta: text });
			if (ended) yield update({ type: "toolcall_end", contentIndex, toolCall: block }, true);
			return;
		}
		default:
			return;
	}
}

function* messageFrames(message: ActiveMessageView, resolved: ResolvedNames): Generator<Frame> {
	const start = legacyMessage(message, "start");
	if (!start) return;
	yield { type: "message_start", message: start };
	if (!("role" in start) || start.role !== "assistant") return;
	for (const block of message.blocks) yield* blockFrames(block, message.fields?.usage, resolved);
}

function remainingMs(dialog: CompactDialog, now: number): number {
	return typeof dialog.deadlineAtMs === "number" ? Math.max(0, dialog.deadlineAtMs - now) : 0;
}

async function activeMessage({ lane, root }: LegacyViewSource): Promise<ActiveMessageView | undefined> {
	if (root.activeMessageId === null) return undefined;
	const messages = await lane.readCurrentActive(root);
	return messages.find((message) => message.messageId === root.activeMessageId);
}

/** The resolved names the calls component kept at the cut for the blocks of one message, by content index. */
async function resolvedNames({ lane, root }: LegacyViewSource, messageId: string): Promise<ResolvedNames> {
	const names = new Map<number, string>();
	for (const call of (await lane.readCurrentCalls(root)).calls)
		if (call.owningMessageId === messageId && call.contentIndex !== null && call.resolvedName !== null)
			names.set(call.contentIndex, call.resolvedName);
	return names;
}

/**
 * Today's floor from the frozen view (RULING-25 Q1, Q4): the latest lifecycle, the active message as its start
 * plus prefix deltas, then each still-open broadcast question with its original id and the remaining time at the
 * freeze clock. Every root is read before the first frame leaves, so a failed read delivers nothing at all; a read
 * that failed because the view was cancelled meanwhile (cursor released, lane replaced, or its root released by a
 * retirement) is not reported. A seal keeps a queued view's root, so that view is delivered (RULING-51 Q2=A).
 */
async function* attachFrames(
	sessionId: string,
	source: LegacyViewSource,
	view: LegacyAttachView,
	cancelled: () => boolean,
) {
	let read: {
		readonly components: Awaited<ReturnType<SessionAcceptanceLane["readCurrentComponents"]>>;
		readonly message: ActiveMessageView | undefined;
		readonly resolved: ResolvedNames;
	};
	try {
		read = await source.hold(async () => {
			const components = await source.lane.readCurrentComponents(source.root);
			const message = await activeMessage(source);
			const resolved = message ? await resolvedNames(source, message.messageId) : new Map<number, string>();
			return { components, message, resolved };
		});
	} catch (cause) {
		if (!cancelled()) unavailable(sessionId, cause);
		return;
	}
	const { components, message, resolved } = read;
	const encode = (frame: Frame) => serializeJsonLine(view.placeholders ? omitNormalInlineMedia(frame) : frame);
	const tag = (frame: Frame): Frame => ({ ...frame, sessionId });
	if (isFrame(components.lifecycle)) yield encode(tag(components.lifecycle));
	if (message) for (const frame of messageFrames(message, resolved)) yield encode(tag(frame));
	for (const dialog of components.dialogs)
		if (dialog.audience === "broadcast" && isFrame(dialog.request))
			yield encode({ ...tag(dialog.request), remainingMs: remainingMs(dialog, view.now) });
}

/** A late peer's attach baseline from the lane's frozen view; a source without a readable cut is empty. */
export function legacyAttachView(
	sessionId: string,
	source: LegacyViewSource | undefined,
	view: LegacyAttachView,
	onRelease: () => void,
): LegacyViewCursor {
	const current = source?.root.current;
	const empty =
		source === undefined ||
		current === undefined ||
		(current.components.lifecycle === undefined &&
			current.components.dialogCounts.broadcast === 0 &&
			source.root.activeMessageId === null);
	let released = false;
	const epoch = source?.lane.recoveryEpoch;
	const cancelled = () =>
		released || (source !== undefined && !source.lane.holds(source.root)) || source?.lane.recoveryEpoch !== epoch;
	return new GeneratedFramesCursor(
		empty,
		() => (source ? attachFrames(sessionId, source, view, cancelled) : (async function* () {})()),
		() => {
			released = true;
			onRelease();
		},
	);
}

/**
 * The message slot of a session's `resync_required` frame: C's active message, or null when it has none. A cut the
 * host could not serve (`storage_unavailable`) is reported once; a retired lane has nothing to report. The cut reads
 * only a root it retained at the freeze, so no reclaim before its delivery can take the message from it.
 */
export async function legacyResyncMessage(
	sessionId: string,
	source: RecoveryOutcome<RetainedRoot> | undefined,
): Promise<unknown> {
	if (!source) return null;
	if (!source.ok) {
		if (REPORTED[refusalReason(source.failure)]) unavailable(sessionId, source.failure.reason);
		return null;
	}
	const { value } = source;
	return value.hold(async () => {
		try {
			const message = await activeMessage(value);
			return (message && legacyMessage(message, "current")) ?? null;
		} catch (cause) {
			// Under the hold only the lane itself can release the root (a retirement): nothing to report then.
			if (value.lane.holds(value.root)) unavailable(sessionId, cause);
			return null;
		}
	});
}
