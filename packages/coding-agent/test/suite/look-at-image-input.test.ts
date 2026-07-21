import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type LookAtImageInputContext,
	loadLookAtInputs,
	parseImageAttachmentReference,
} from "../../src/core/extensions/builtin/look-at/image-input.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=",
	"base64",
);
const JPEG = Buffer.from(
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ap//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
	"base64",
);
const directories: string[] = [];

function context(overrides?: Partial<LookAtImageInputContext>): LookAtImageInputContext {
	return {
		cwd: tmpdir(),
		getImageSettings: () => ({ autoResize: false, blockImages: false }),
		sessionManager: { getBranch: () => [] } as LookAtImageInputContext["sessionManager"],
		...overrides,
	};
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "look-at-input-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("look_at image input loader", () => {
	it("detects PNG and JPEG MIME types from real magic-byte file fixtures", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "fixture.png"), PNG);
		await writeFile(join(cwd, "fixture.jpg"), JPEG);

		const inputs = await loadLookAtInputs(context({ cwd }), ["fixture.png", "fixture.jpg"], []);

		expect(inputs.map((input) => input.mimeType)).toEqual(["image/png", "image/jpeg"]);
	});

	it("parses and resolves current-turn image attachment reference forms only", async () => {
		expect(parseImageAttachmentReference("Image #2")).toEqual({ index: 2 });
		expect(parseImageAttachmentReference(" attachment://1 ")).toEqual({ index: 1 });
		expect(parseImageAttachmentReference("Image #0")).toBeNull();
		expect(parseImageAttachmentReference("picture.png")).toBeNull();
		const sessionManager = {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }],
					},
				},
			],
		} as LookAtImageInputContext["sessionManager"];

		const [attachment] = await loadLookAtInputs(context({ sessionManager }), ["attachment://1"], []);
		expect(attachment.label).toBe("Image #1");
		expect(attachment.mimeType).toBe("image/png");
	});

	it("rejects an input larger than the 10MiB per-image cap", async () => {
		await expect(
			loadLookAtInputs(context(), [], [Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64")]),
		).rejects.toThrow("10MiB per-image limit");
	});

	it("rejects multiple inputs whose combined raw size exceeds the 25MiB aggregate cap", async () => {
		const image = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]).toString("base64");
		await expect(loadLookAtInputs(context(), [], [image, image, image])).rejects.toThrow("25MiB aggregate limit");
	});

	it("passes detected non-image media through without image processing", async () => {
		const pdf = Buffer.from("%PDF-1.7\nexample");
		const [input] = await loadLookAtInputs(
			context({ getImageSettings: () => ({ autoResize: true, blockImages: false }) }),
			[],
			[pdf.toString("base64")],
		);

		expect(input.mimeType).toBe("application/pdf");
		expect(input.data).toBe(pdf.toString("base64"));
	});

	it("rejects base64 data whose MIME type cannot be determined", async () => {
		await expect(loadLookAtInputs(context(), [], [Buffer.from("not an image").toString("base64")])).rejects.toThrow(
			"Could not determine MIME type",
		);
	});

	it("rejects inputs when image blocking is enabled", async () => {
		await expect(
			loadLookAtInputs(
				context({ getImageSettings: () => ({ autoResize: false, blockImages: true }) }),
				[],
				[PNG.toString("base64")],
			),
		).rejects.toThrow("blocked by settings");
	});

	it("reports a missing file using the original path", async () => {
		await expect(loadLookAtInputs(context(), ["missing.png"], [])).rejects.toThrow(
			"Error: File not found: missing.png",
		);
	});
});
