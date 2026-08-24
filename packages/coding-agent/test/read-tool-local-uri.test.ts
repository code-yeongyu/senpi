import { describe, expect, it } from "vitest";
import { createReadTool } from "../src/index.ts";

const GUIDANCE_PHRASE = "URIs resolve only inside eval cells";

const readTool = createReadTool(process.cwd());

async function rejectedMessage(path: string): Promise<string> {
	try {
		await readTool.execute("read-tool-local-uri", { path });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`expected read to reject for path: ${path}`);
}

function expectLocalUriGuidance(message: string): void {
	expect(message).toContain("local://");
	expect(message).toMatch(/eval/i);
	expect(message).not.toContain("ENOENT");
}

function expectClassicNotFound(message: string): void {
	expect(message).toMatch(/ENOENT|not found/i);
	expect(message).not.toContain(GUIDANCE_PHRASE);
}

describe("read tool local:// URI guard", () => {
	it('rejects path "local://detached-eval-eval_5.log" with guidance and no ENOENT', async () => {
		expectLocalUriGuidance(await rejectedMessage("local://detached-eval-eval_5.log"));
	});

	it('rejects path "local://" with the same guidance error', async () => {
		expectLocalUriGuidance(await rejectedMessage("local://"));
	});

	it('rejects uppercase scheme "LOCAL://x.log" with the same guidance error', async () => {
		expectLocalUriGuidance(await rejectedMessage("LOCAL://x.log"));
	});

	it("returns a classic not-found error for a missing filesystem path", async () => {
		expectClassicNotFound(await rejectedMessage("definitely-missing-file-12345.txt"));
	});

	it("treats a single-slash local:/ path as an ordinary relative path", async () => {
		expectClassicNotFound(await rejectedMessage("local:/single-slash.txt"));
	});
});
