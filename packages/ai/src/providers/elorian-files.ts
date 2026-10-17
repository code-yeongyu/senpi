import type { Api, Model, StreamOptions } from "../types.ts";

export interface ElorianFileOptions {
	/** Deadline for the whole upload and processing lifecycle. Default: ten minutes. */
	fileTimeoutMs?: number;
	/** Files only expose retrieval, so processing is polled. Default: one second. */
	filePollIntervalMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Uploads a clip using the same endpoint, credentials, fetch, and abort signal as chat. */
export async function uploadElorianVideo(
	video: Blob,
	model: Model<Api>,
	options: StreamOptions,
	config: ElorianFileOptions = {},
): Promise<string> {
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(config.fileTimeoutMs ?? options.timeoutMs ?? 600_000),
	]);
	const headers = new Headers();
	if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
	for (const source of [model.headers, options.headers]) {
		for (const [key, value] of Object.entries(source ?? {})) {
			if (value === null) headers.delete(key);
			else headers.set(key, value);
		}
	}
	// Let fetch supply the multipart boundary, rather than inheriting a chat JSON header.
	headers.delete("content-type");
	const request = async (
		path: string,
		body?: FormData | Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		signal.throwIfAborted();
		const response = await (options.fetch ?? globalThis.fetch)(`${model.baseUrl.replace(/\/$/, "")}${path}`, {
			method: body ? "POST" : "GET",
			headers:
				body && !(body instanceof FormData)
					? { ...Object.fromEntries(headers), "Content-Type": "application/json" }
					: headers,
			body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
			signal,
		});
		if (!response.ok) throw new Error(`Elorian file request failed (${response.status}): ${await response.text()}`);
		const result: unknown = await response.json();
		if (!record(result)) throw new Error("Elorian file response must be an object");
		return result;
	};
	const filename = `video.${video.type.split("/")[1]?.split(";")[0] || "mp4"}`;
	let file: Record<string, unknown>;
	if (video.size <= 512 * 1024 * 1024) {
		const form = new FormData();
		form.set("file", video, filename);
		form.set("purpose", "vision");
		file = await request("/files", form);
	} else {
		const upload = await request("/uploads", {
			filename,
			bytes: video.size,
			mime_type: video.type,
			purpose: "vision",
		});
		if (typeof upload.id !== "string") throw new Error("Elorian upload response is missing id");
		const path = `/uploads/${encodeURIComponent(upload.id)}`;
		const partIds: string[] = [];
		const chunkSize = 64 * 1024 * 1024;
		for (let offset = 0; offset < video.size; offset += chunkSize) {
			const form = new FormData();
			form.set("data", video.slice(offset, Math.min(offset + chunkSize, video.size)), filename);
			const part = await request(`${path}/parts`, form);
			if (typeof part.id !== "string") throw new Error("Elorian upload part response is missing id");
			partIds.push(part.id);
		}
		const completed = await request(`${path}/complete`, { part_ids: partIds });
		if (!record(completed.file)) throw new Error("Elorian completed upload is missing file");
		file = completed.file;
	}
	for (;;) {
		signal.throwIfAborted();
		if (typeof file.id !== "string") throw new Error("Elorian file response is missing id");
		switch (file.status) {
			case "ready":
				return `file://${file.id}`;
			case "failed":
				throw new Error(`Elorian video processing failed: ${JSON.stringify(file.last_error ?? "unknown error")}`);
			case "processing":
			case "uploading":
				break;
			default:
				throw new Error(`Unknown Elorian file status: ${String(file.status)}`);
		}
		await new Promise<void>((resolve, reject) => {
			const abort = () => {
				clearTimeout(timer);
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, config.filePollIntervalMs ?? 1000);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		file = await request(`/files/${encodeURIComponent(file.id)}`);
	}
}
