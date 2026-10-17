import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getShareViewerBase, isShareDisabledByEnvironment } from "../../../src/config.ts";
import type { ShareRedactionContext } from "../../../src/core/share/share-redaction.ts";
import {
	runShare,
	type ShareDecision,
	type ShareDependencies,
	type ShareUploadResult,
} from "../../../src/core/share/share-session.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3524: /share uploaded the whole session unredacted with no confirmation. The secret is
// assembled at runtime so no credential-shaped literal sits in the repository.
const SECRET = ["sk", "test", "0".repeat(24)].join("-");
const HOME = "/Users/jane doe";
const context: ShareRedactionContext = { homeDirectory: HOME, userName: "janedoe", hostName: "janes-mbp.local" };

const catEnv: AgentTool = {
	name: "cat_env",
	label: "Cat env",
	description: "Print the project .env file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: `OPENAI_API_KEY=${SECRET}\nread from ${HOME}/project/.env` }],
		details: {},
	}),
};

/** Answers once; a second question means a choice was ignored, so it fails instead of looping. */
function askOnce(answer: (preview: string) => ShareDecision) {
	return vi
		.fn(async (_preview: string): Promise<ShareDecision> => {
			throw new Error("asked again after the first answer");
		})
		.mockImplementationOnce(async (preview: string) => answer(preview));
}

function sessionPayload(html: string): string {
	const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html);
	const encoded = match?.[1] ?? "";
	return Buffer.from(encoded, "base64").toString("utf8");
}

describe("/share consent and redaction (senpi#3524)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	async function sessionWithSecretToolResult(): Promise<Harness> {
		const harness = await createHarness({ tools: [catEnv], persistSession: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("cat_env", { path: `${HOME}/project/.env` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Your key is set; mail janedoe@example.org if it breaks."),
		]);
		await harness.session.prompt(`check ${HOME}/project/.env`);
		await harness.session.waitForIdle();
		return harness;
	}

	function dependencies(
		harness: Harness,
		decisions: ShareDecision[],
		uploads: string[],
		overrides: Partial<ShareDependencies> = {},
	): ShareDependencies {
		return {
			disabledReason: () => undefined,
			checkGh: () => "ok",
			render: (sanitize) => harness.session.renderToHtml({ sanitize }),
			context,
			ask: async () => decisions.shift() ?? "cancel",
			showReviewCopy: () => {},
			upload: async (html): Promise<ShareUploadResult> => {
				uploads.push(html);
				return { code: 0, stdout: "https://gist.github.com/janedoe/abc123\n", stderr: "", aborted: false };
			},
			viewerBase: undefined,
			...overrides,
		};
	}

	it("uploads only redacted bytes after the user chooses Upload", async () => {
		const harness = await sessionWithSecretToolResult();
		const uploads: string[] = [];
		const outcome = await runShare(dependencies(harness, ["upload"], uploads));

		expect(outcome).toEqual({
			kind: "shared",
			gistUrl: "https://gist.github.com/janedoe/abc123",
			viewerUrl: undefined,
		});
		expect(uploads).toHaveLength(1);
		const uploaded = uploads[0] ?? "";
		const payload = sessionPayload(uploaded);
		expect(payload).toContain("OPENAI_API_KEY=<redacted>");
		for (const leaked of [SECRET, HOME, "jane doe", "janedoe@example.org"]) {
			expect(payload).not.toContain(leaked);
			expect(uploaded).not.toContain(leaked);
		}
	});

	it("uploads nothing when the user cancels", async () => {
		const harness = await sessionWithSecretToolResult();
		const uploads: string[] = [];
		const ask = askOnce(() => "cancel");
		const outcome = await runShare({ ...dependencies(harness, [], uploads), ask });

		expect(outcome).toEqual({ kind: "cancelled" });
		expect(ask).toHaveBeenCalledTimes(1);
		expect(uploads).toEqual([]);
	});

	it("shows the preview with the redaction counts and the gist visibility before asking", async () => {
		const harness = await sessionWithSecretToolResult();
		const previews: string[] = [];
		await runShare({
			...dependencies(harness, [], []),
			ask: askOnce((preview) => {
				previews.push(preview);
				return "cancel";
			}),
		});
		expect(previews[0]).toMatch(/Removed first: .*credential/);
		expect(previews[0]).toContain("anyone with the link");
		expect(previews[0]).toContain("No viewer is configured");
	});

	it("writes the review copy owner-only, identical to the upload, and removes it afterwards", async () => {
		const harness = await sessionWithSecretToolResult();
		const uploads: string[] = [];
		const reviewed: Array<{ path: string; mode: number; text: string }> = [];
		await runShare(
			dependencies(harness, ["review", "upload"], uploads, {
				showReviewCopy: (path) =>
					reviewed.push({ path, mode: statSync(path).mode & 0o777, text: readFileSync(path, "utf8") }),
			}),
		);

		expect(reviewed).toHaveLength(1);
		const copy = reviewed[0];
		if (!copy) throw new Error("no review copy was shown");
		if (process.platform !== "win32") expect(copy.mode).toBe(0o600);
		expect(copy.text).toBe(uploads[0]);
		expect(existsSync(dirname(copy.path))).toBe(false);
	});

	it("does nothing at all when sharing is disabled", async () => {
		const harness = await sessionWithSecretToolResult();
		const uploads: string[] = [];
		const render = vi.fn(() => "");
		const checkGh = vi.fn((): "ok" => "ok");
		const outcome = await runShare({
			...dependencies(harness, ["upload"], uploads),
			disabledReason: () => "off",
			render,
			checkGh,
		});
		expect(outcome).toEqual({ kind: "disabled", reason: "off" });
		expect(render).not.toHaveBeenCalled();
		expect(checkGh).not.toHaveBeenCalled();
		expect(uploads).toEqual([]);
	});

	it("has no third-party viewer by default and honors the kill switch", () => {
		for (const name of ["SENPI_SHARE_VIEWER_URL", "PI_SHARE_VIEWER_URL", "SENPI_DISABLE_SHARE", "PI_DISABLE_SHARE"]) {
			vi.stubEnv(name, "");
		}
		expect(getShareViewerBase()).toBeUndefined();
		expect(isShareDisabledByEnvironment()).toBe(false);
		vi.stubEnv("SENPI_DISABLE_SHARE", "1");
		expect(isShareDisabledByEnvironment()).toBe(true);
	});
});
