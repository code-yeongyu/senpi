/**
 * video-in — model-gated video file input (kimi-code `ReadMediaFile` parity).
 *
 * Registers a `read_video` tool that reads a local video file and attaches it
 * to the conversation as a base64 video payload. The tool is only active when
 * the current model declares the "video" input modality (currently only
 * kimi-coding `k3`); on `session_start` and `model_select` it is added to or
 * removed from the active tool set accordingly.
 *
 * Wire behavior: the payload rides an ImageContent block with a `video/*`
 * mimeType. The anthropic-messages API serializes such blocks as
 * `{type:"video", source:{type:"base64", media_type, data}}`, which the Kimi
 * Anthropic-compatible endpoint accepts (verified against MoonshotAI/kimi-code
 * kosong anthropic provider). transform-messages downgrades the block to a
 * placeholder for models without the "video" modality, so switching models
 * mid-session cannot wedge the request.
 */
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve as resolvePath } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../types.ts";

const TOOL_NAME = "read_video";

/** Same cap as kimi-code's ReadMediaFile (base64 inflates ~4/3 on the wire). */
const MAX_VIDEO_MEGABYTES = 100;
const MAX_VIDEO_BYTES = MAX_VIDEO_MEGABYTES * 1024 * 1024;

/** Extension -> mime map mirrored from kimi-code's supported video set. */
const EXT_TO_MIME: Record<string, string> = {
	mp4: "video/mp4",
	mpeg: "video/mpeg",
	mpg: "video/mpeg",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	flv: "video/x-flv",
	"3gp": "video/3gpp",
};

function detectVideoMimeType(path: string): string | undefined {
	const ext = extname(path).slice(1).toLowerCase();
	return EXT_TO_MIME[ext];
}

function modelSupportsVideo(model: Model<any> | undefined): boolean {
	return model?.input?.includes("video") === true;
}

const readVideoSchema = Type.Object({
	path: Type.String({ description: "Path to a video file (relative or absolute). Max 100MB." }),
});

export default function videoInExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Read Video",
		description:
			`Read a video file (${Object.keys(EXT_TO_MIME).join(", ")}) and attach it to the conversation so you can watch it. ` +
			`Maximum file size ${MAX_VIDEO_MEGABYTES}MB. ` +
			"Use this to understand screen recordings, demo clips, or any behavior that is hard to describe in text. " +
			"If you generate or edit a video via commands or scripts, read the result back before continuing.",
		promptSnippet: "Attach a video file so the model can watch it (video-capable models only)",
		parameters: readVideoSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!modelSupportsVideo(ctx.model)) {
				throw new Error(
					"The current model does not support video input. Tell the user to switch to a model with video input capability (e.g. kimi-coding/k3).",
				);
			}
			const absolutePath = isAbsolute(params.path) ? params.path : resolvePath(ctx.cwd, params.path);
			const mimeType = detectVideoMimeType(absolutePath);
			if (!mimeType) {
				throw new Error(
					`"${params.path}" is not a supported video file. Supported extensions: ${Object.keys(EXT_TO_MIME).join(", ")}.`,
				);
			}
			const stats = await fsStat(absolutePath);
			if (!stats.isFile()) {
				throw new Error(`"${params.path}" is not a regular file.`);
			}
			if (stats.size === 0) {
				throw new Error(`"${params.path}" is empty.`);
			}
			if (stats.size > MAX_VIDEO_BYTES) {
				throw new Error(
					`"${params.path}" is ${stats.size} bytes, which exceeds the maximum ${MAX_VIDEO_MEGABYTES}MB for video files. Create a smaller clip (e.g. with ffmpeg) and read that instead.`,
				);
			}
			const data = await fsReadFile(absolutePath);
			if (signal?.aborted) throw new Error("Operation aborted");
			return {
				content: [
					{
						type: "text",
						text: `Read video file "${basename(absolutePath)}" [${mimeType}, ${stats.size} bytes]. The video is attached below.`,
					},
					{ type: "image", data: data.toString("base64"), mimeType },
				],
				details: undefined,
			};
		},
	});

	function syncToolActivation(model: Model<any> | undefined): void {
		const active = pi.getActiveTools();
		const isActive = active.includes(TOOL_NAME);
		const shouldBeActive = modelSupportsVideo(model);
		if (shouldBeActive && !isActive) {
			pi.setActiveTools([...active, TOOL_NAME]);
		} else if (!shouldBeActive && isActive) {
			pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		syncToolActivation(ctx.model);
	});

	pi.on("model_select", async (event) => {
		syncToolActivation(event.model);
	});
}
