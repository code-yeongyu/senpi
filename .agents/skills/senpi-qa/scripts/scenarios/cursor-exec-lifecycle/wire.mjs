/**
 * Wire codec for the fake Cursor backend used by cursor-exec-lifecycle-qa.
 *
 * Loads the REAL generated protobuf schemas from the worktree's TypeScript
 * source (`packages/ai/src/api/cursor-agent/gen/agent_pb.ts`) through tsx's
 * programmatic ESM loader, so the fake server decodes exactly the messages
 * the production client encodes — no hand-rolled protobuf.
 *
 * Server→client frames are built here; client→server frames are summarized
 * (decoded + reduced to the fields the assertions need).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { tsImport } from "tsx/esm/api";
import { repoRoot } from "../../lib/common.mjs";

export const RUN_PATH = "/agent.v1.AgentService/Run";
export const CONNECT_END_STREAM_FLAG = 0b10;

let cached;

export async function loadCursorWire() {
	if (cached) return cached;
	const root = repoRoot();
	const gen = join(root, "packages", "ai", "src", "api", "cursor-agent", "gen", "agent_pb.ts");
	const pb = await tsImport(gen, { parentURL: pathToFileURL(join(root, "/")).href });
	const update = (inner) =>
		create(pb.AgentServerMessageSchema, { message: { case: "interactionUpdate", value: inner } });
	const frame = (message, flags = 0) => {
		const bytes = toBinary(pb.AgentServerMessageSchema, message);
		const head = Buffer.alloc(5);
		head[0] = flags;
		head.writeUInt32BE(bytes.length, 1);
		return Buffer.concat([head, Buffer.from(bytes)]);
	};
	const textUpdate = (text) =>
		update({
			message: { case: "textDelta", value: create(pb.TextDeltaUpdateSchema, { text }) },
		});
	const turnEndedUpdate = () =>
		update({ message: { case: "turnEnded", value: create(pb.TurnEndedUpdateSchema, {}) } });
	const exec = (id, message) =>
		frame(
			create(pb.AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(pb.ExecServerMessageSchema, { id, execId: `exec-${id}`, message }),
				},
			}),
		);
	cached = {
		schemas: pb,
		textDeltaFrame: (text) => frame(textUpdate(text)),
		turnEndedFrame: () => frame(turnEndedUpdate()),
		endStreamFrame: () => {
			const body = Buffer.from(JSON.stringify({}));
			const head = Buffer.alloc(5);
			head[0] = CONNECT_END_STREAM_FLAG;
			head.writeUInt32BE(body.length, 1);
			return Buffer.concat([head, body]);
		},
		execReadFrame: ({ id, path, toolCallId }) =>
			exec(id, { case: "readArgs", value: create(pb.ReadArgsSchema, { path, toolCallId }) }),
		execShellStreamFrame: ({ id, command, workingDirectory, toolCallId }) =>
			exec(id, {
				case: "shellStreamArgs",
				// `shell_stream_args` reuses the ShellArgs message on the wire.
				value: create(pb.ShellArgsSchema, { command, workingDirectory, toolCallId }),
			}),
		/** Reduce one decoded AgentClientMessage to the fields QA asserts on. */
		summarizeClient: (bytes) => {
			const message = fromBinary(pb.AgentClientMessageSchema, bytes);
			const entry = { case: message.message.case ?? "unset" };
			const value = message.message.value;
			if (message.message.case === "execClientControlMessage" && value) {
				entry.control = value.message.case ?? "unset";
				entry.id = value.message.value?.id ?? null;
				entry.execId = value.execId ?? null;
				entry.idIsNumeric = typeof entry.id === "number";
			} else if (message.message.case === "execClientMessage" && value) {
				entry.message = value.message.case ?? "unset";
				entry.id = value.id ?? null;
				entry.execId = value.execId ?? null;
				entry.idIsNumeric = typeof entry.id === "number";
				entry.result = value.message.value?.result?.case ?? null;
				if (entry.message === "readResult" && entry.result === "success") {
					entry.readLines = value.message.value.totalLines ?? null;
				}
			} else if (message.message.case === "runRequest") {
				entry.conversationId = value?.conversationId ?? null;
				entry.requestId = randomUUID().slice(0, 8);
			}
			try {
				entry.detail = JSON.stringify(toJson(pb.AgentClientMessageSchema, message)).slice(0, 240);
			} catch {
				entry.detail = "<unserializable>";
			}
			return entry;
		},
	};
	return cached;
}
