import { getAssistantCapture, SeedFrontierError } from "@earendil-works/pi-ai";
import { envValue } from "../../core/brand.ts";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionStructuredRecord } from "../../core/structured-session-lane.ts";
import { type SeededJsonAgentSessionEvent, toJsonEvent } from "../json-event.ts";
import { subscribeSessionRecords } from "./session-record-stream.ts";

/**
 * The engine-socket compact-updates rollout flag (`<brand>_ENGINE_SOCKET_COMPACT_UPDATES`), explicit-true only.
 * Off, no session holds a structured subscription and every destination keeps its existing bytes.
 */
export function structuredLaneEnabled(): boolean {
	const value = envValue("ENGINE_SOCKET_COMPACT_UPDATES");
	return value === "1" || value === "true";
}

type BlockState = "open" | "ended" | "invalid";
const SEEDS = { blockSeeds: 1 } as const;

/**
 * Admits a block's records only after its own seed or insert reached this subscriber, so a subscriber that attached
 * mid-message gets no seed, delta or control for that message, never a wrong one. A started block whose next record
 * has no capture, or that has no accepted end when the message ends, is invalid: its later records are dropped and
 * the assistant `message_end` names it in `invalidatedBlocks`, so a reader rebuilds it from the terminal message.
 * A terminal that rewrote blocks from `rewrittenFrom` on invalidates every block at or above that index, and a
 * `message_end` with no interpretable terminal capture (cancel, idle timeout) invalidates every block of the message.
 * Blocks are addressed by the capture's own index (`capture.contentIndex ?? event.contentIndex`), never a drifted public one.
 */
class SeededBlockGate {
	private blocks: Map<number, BlockState> | undefined;
	private readonly nextOffsets = new Map<number, number>();

	accept(record: AgentSessionStructuredRecord): object | undefined {
		if (record.type === "message_block_state" || record.type === "message_block_metadata")
			return this.control(record, record.type === "message_block_state" ? record.phase : undefined);
		if (record.type === "message_tool_arguments_reset") {
			const accepted = this.control(record);
			if (accepted) this.nextOffsets.set(record.contentIndex, record.rawArgumentPrefix.length);
			return accepted;
		}
		if (record.type === "message_start" && record.message.role === "assistant") {
			const seeded = toJsonEvent(record, SEEDS);
			this.blocks = seeded && new Map();
			this.nextOffsets.clear();
			return seeded;
		}
		if (record.type === "message_end" && record.message.role === "assistant") return this.end(record);
		if (record.type !== "message_update") return toJsonEvent(record, SEEDS);
		if (!this.blocks) return undefined;
		const update = record.assistantMessageEvent;
		if (!("contentIndex" in update)) return toJsonEvent(record, SEEDS);
		const index = getAssistantCapture(record)?.contentIndex ?? update.contentIndex;
		const starts =
			update.type === "text_start" || update.type === "thinking_start" || update.type === "toolcall_start";
		if (starts && this.nextOffsets.has(index)) {
			this.blocks.set(index, "invalid");
			return undefined;
		}
		if (this.blocks.get(index) === "invalid") return undefined;
		if (!starts && this.blocks.get(index) !== "open") return undefined;
		let seeded: SeededJsonAgentSessionEvent | undefined;
		try {
			seeded = toJsonEvent(record, SEEDS);
		} catch (error) {
			if (!(error instanceof SeedFrontierError)) throw error;
			this.blocks.set(index, "invalid");
			return undefined;
		}
		const capture = getAssistantCapture(record);
		if (starts && seeded && capture?.nextOffset !== undefined) this.nextOffsets.set(index, capture.nextOffset);
		if ("delta" in update && seeded) {
			if (capture?.offset !== this.nextOffsets.get(index) || capture?.offset === undefined) {
				this.blocks.set(index, "invalid");
				return undefined;
			}
			this.nextOffsets.set(index, capture.offset + update.delta.length);
		}
		const ends = update.type === "text_end" || update.type === "thinking_end" || update.type === "toolcall_end";
		this.blocks.set(index, seeded ? (ends ? "ended" : "open") : "invalid");
		return seeded;
	}

	private control(
		record: AgentSessionStructuredRecord & { contentIndex: number },
		phase?: "insert" | "end",
	): object | undefined {
		const state = this.blocks?.get(record.contentIndex);
		if (!this.blocks || state === "invalid") return undefined;
		if (phase === "insert") this.blocks.set(record.contentIndex, "open");
		else if (state === undefined || (phase === "end" && state !== "open")) return undefined;
		else if (phase === "end") this.blocks.set(record.contentIndex, "ended");
		return record;
	}

	private end(record: Extract<AgentSessionEvent, { type: "message_end" }>): object {
		const capture = getAssistantCapture(record);
		const rewrittenFrom = capture?.message === undefined ? 0 : (capture.rewrittenFrom ?? Number.POSITIVE_INFINITY);
		const invalidatedBlocks = [...(this.blocks ?? [])].flatMap(([index, state]) =>
			state === "ended" && index < rewrittenFrom ? [] : [index],
		);
		this.blocks = undefined;
		this.nextOffsets.clear();
		const seeded = toJsonEvent(record, SEEDS) ?? record;
		return invalidatedBlocks.length === 0
			? seeded
			: { ...seeded, invalidatedBlocks: invalidatedBlocks.sort((a, b) => a - b) };
	}
}

/**
 * The session's internal structured lane, correlated like its legacy records: seeded `toJsonEvent` projections of
 * every session event plus the three block controls, in session order. Never a legacy destination.
 */
export function subscribeStructuredSessionRecords(session: AgentSession, output: (record: object) => void): () => void {
	const gate = new SeededBlockGate();
	return subscribeSessionRecords(session, output, undefined, (listener) =>
		session.subscribeStructured((record) => {
			const accepted = gate.accept(record);
			// Correlation reads only `type`, `role` and outer fields, which seeded records and controls keep.
			if (accepted) listener(accepted as AgentSessionEvent);
		}),
	);
}
