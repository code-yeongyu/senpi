import { persistToolImage } from "../../../src/modes/rpc/tool-media-store.ts";

const [sessionDir, durableSessionId, writer] = process.argv.slice(2);
if (!sessionDir || !durableSessionId || !writer || !process.send) throw new Error("Missing writer arguments");

const data = Buffer.alloc(64);
Buffer.from("89504e470d0a1a0a", "hex").copy(data);
const block = { data: data.toString("base64"), mimeType: "image/png" };

process.on("message", (toolCallId: unknown) => {
	if (typeof toolCallId !== "string") throw new TypeError("Expected tool call ID");
	void Promise.resolve(
		persistToolImage(
			{ sessionDir, durableSessionId },
			{ toolCallId: `${writer}-${toolCallId}`, contentIndex: 0 },
			{
				...block,
			},
		),
	).then((result) => {
		process.send?.(result);
	});
});
