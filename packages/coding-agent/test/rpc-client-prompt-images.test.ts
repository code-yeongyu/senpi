import type { ImageContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

describe("RpcClient.prompt legacy image API", () => {
	it("sends images when called with the baseline message, images signature", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		(client as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command) => {
			sent.push(command);
			return { type: "response", command: "prompt", success: true };
		};
		const images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] as ImageContent[];

		await client.prompt("with-image", images);

		expect(sent).toEqual([{ type: "prompt", message: "with-image", images }]);
	});
});
