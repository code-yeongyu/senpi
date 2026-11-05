import type { MediaPersister } from "../../../src/modes/rpc/media-placeholders.ts";

/**
 * The ordinary records the `media_placeholders` transform handles today, and the observable result of running a
 * transform over them: each output's exact JSON, whether the record itself came back by reference, every container
 * path whose input object was kept by reference, and every persister call in order. The golden file next to this
 * module was written from the recursive walk before it became iterative (part of #4272, S11a).
 */

const PNG = "aGVsbG8gd29ybGQh";
const JPEG = "/9j/4AAQSkZJRgABAQ==";
const GIF = "R0lGODlhAQABAAAAACw=";

const image = (data: string, mimeType?: string) =>
	mimeType === undefined ? { type: "image", data } : { type: "image", data, mimeType };

const toolResult = (toolCallId: string | undefined, content: unknown, extra: Record<string, unknown> = {}) => ({
	role: "toolResult",
	...(toolCallId === undefined ? {} : { toolCallId }),
	toolName: "read",
	content,
	...extra,
	isError: false,
	timestamp: 1,
});

/** One toolResult object referenced twice in a record: the walk visits each occurrence. */
const shared = toolResult("shared", [{ type: "text", text: "twice" }, image(PNG, "image/png")]);

export function goldenCases(): Array<{ readonly name: string; readonly record: Record<string, unknown> }> {
	return [
		{
			name: "message_end toolResult with two images, details kept",
			record: {
				type: "message_end",
				message: toolResult("call_1", [{ type: "text", text: "a" }, image(PNG, "image/png"), image(JPEG)], {
					details: { rows: [[1, 2], { deep: { deeper: [true, null, "x"] } }] },
				}),
			},
		},
		{
			name: "turn_end assistant message and toolResults",
			record: {
				type: "turn_end",
				message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 2 } },
				toolResults: [
					toolResult("call_2", [image(GIF, "image/gif")]),
					toolResult("call_3", [{ type: "text", text: "no image" }]),
				],
			},
		},
		{
			name: "agent_end user image kept, tool image replaced",
			record: {
				type: "agent_end",
				messages: [
					{ role: "user", content: [{ type: "text", text: "look" }, image(PNG, "image/png")] },
					toolResult("call_4", [image(PNG, "image/png")]),
					{ role: "assistant", content: [{ type: "text", text: "seen" }] },
				],
			},
		},
		{
			name: "scrubbed toolResult skips its content, walks its other keys",
			record: {
				type: "message_start",
				message: toolResult(
					"call_5",
					[image(PNG, "image/png"), { type: "custom", inner: toolResult("inner_a", [image(JPEG, "image/jpeg")]) }],
					{ details: { nested: toolResult("inner_b", [image(GIF, "image/gif")]) } },
				),
			},
		},
		{
			name: "unscrubbed toolResult walks its content",
			record: {
				type: "message_end",
				message: toolResult("call_6", [
					{ type: "text", text: "plain" },
					{ type: "custom", inner: toolResult("inner_c", [image(PNG, "image/png")]) },
				]),
			},
		},
		{
			name: "get_messages response",
			record: {
				type: "response",
				command: "get_messages",
				success: true,
				id: "r1",
				data: { messages: [toolResult(undefined, [image(PNG)]), toolResult("call_7", "not an array")] },
			},
		},
		{
			name: "get_tree response, nested nodes",
			record: {
				type: "response",
				command: "get_tree",
				success: true,
				data: {
					tree: [
						{
							entry: { id: "e1", type: "message", message: toolResult("call_8", [image(PNG, "image/png")]) },
							children: [
								{
									entry: { id: "e2", type: "message", message: { role: "user", content: "hi" } },
									children: [
										{
											entry: {
												id: "e3",
												type: "message",
												message: toolResult("call_9", [image(JPEG, "image/jpeg")]),
											},
											children: [],
										},
									],
								},
							],
						},
					],
				},
			},
		},
		{
			name: "get_state response, state.entries",
			record: {
				type: "response",
				command: "get_state",
				success: true,
				data: {
					state: {
						entries: [{ type: "message", message: toolResult("call_10", [image(PNG, "image/png")]) }],
						model: { id: "m" },
					},
				},
			},
		},
		{
			name: "open_session response without media",
			record: {
				type: "response",
				command: "open_session",
				success: true,
				data: { sessionId: "s", messages: [{ role: "user", content: "x" }] },
			},
		},
		{
			name: "tool_execution_end result content and a toolResult inside details",
			record: {
				type: "tool_execution_end",
				toolCallId: "call_11",
				toolName: "read",
				result: {
					content: [{ type: "text", text: "t" }, image(PNG, "image/png")],
					details: { echo: toolResult("call_12", [image(GIF, "image/gif")]) },
				},
				isError: false,
			},
		},
		{
			name: "tool_execution_end without media",
			record: {
				type: "tool_execution_end",
				toolCallId: "call_13",
				result: { content: [{ type: "text", text: "t" }], details: { a: [1, [2, [3]]] } },
			},
		},
		{
			name: "entry_appended",
			record: {
				type: "entry_appended",
				entry: { id: "e9", type: "message", message: toolResult("call_14", [image(PNG, "image/png")]) },
			},
		},
		{
			name: "shared toolResult referenced twice",
			record: { type: "agent_end", messages: [shared, { role: "assistant", content: [] }, shared] },
		},
		{
			name: "arrays of arrays around a toolResult",
			record: {
				type: "entry_appended",
				entry: { batches: [[[toolResult("call_15", [image(PNG, "image/png")])]], [[{ k: 1 }]]] },
			},
		},
		{
			name: "message_update is not walked",
			record: { type: "message_update", message: toolResult("call_16", [image(PNG, "image/png")]) },
		},
		{
			name: "response for another command is not walked",
			record: { type: "response", command: "prompt", data: { message: toolResult("call_17", [image(PNG)]) } },
		},
	];
}

type Transform = (record: Record<string, unknown>, persist?: MediaPersister) => Record<string, unknown>;

function keptPaths(input: unknown, output: unknown): string[] {
	const kept: string[] = [];
	const pending: Array<[string, unknown, unknown]> = [["$", input, output]];
	while (pending.length > 0) {
		const [path, before, after] = pending.shift() as [string, unknown, unknown];
		if (typeof before !== "object" || before === null || typeof after !== "object" || after === null) continue;
		if (before === after) {
			kept.push(path);
			continue;
		}
		for (const key of Object.keys(after)) {
			pending.push([`${path}.${key}`, Reflect.get(before, key), Reflect.get(after, key)]);
		}
	}
	return kept;
}

export function goldenOf(transform: Transform): unknown[] {
	return goldenCases().map(({ name, record }) => {
		const calls: string[] = [];
		const persist: MediaPersister = (ref, block) => {
			calls.push(`${ref.toolCallId}#${ref.contentIndex}:${block.mimeType ?? "-"}:${block.data.length}`);
			if (block.mimeType === "image/gif") return { unavailableReason: "image_too_large" };
			if (block.mimeType === "image/jpeg") return undefined;
			return { path: `/media/${ref.toolCallId}-${ref.contentIndex}` };
		};
		const before = JSON.stringify(record);
		const output = transform(record, persist);
		const bare = transform(record);
		return {
			name,
			json: JSON.stringify(output),
			bare: JSON.stringify(bare),
			same: output === record,
			kept: keptPaths(record, output),
			calls,
			inputUnchanged: JSON.stringify(record) === before,
		};
	});
}
