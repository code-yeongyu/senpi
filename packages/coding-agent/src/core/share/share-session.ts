import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newOutputOmissions, omitToolOutputs } from "./share-projection.ts";
import type { ShareRedactionCategory, ShareRedactionContext, ShareRedactionTally } from "./share-redaction.ts";
import { redactShareValue } from "./share-redaction-value.ts";

export type ShareDecision = "upload" | "include-outputs" | "exclude-outputs" | "review" | "cancel";

export interface ShareAskOptions {
	/** Tool outputs left out of this preview; above 0, offer to include them. */
	readonly omittedOutputs: number;
	/** Tool outputs are in this preview; offer to leave them out again. */
	readonly includesOutputs: boolean;
}

export interface ShareUploadResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly aborted: boolean;
}

export interface ShareDependencies {
	readonly disabledReason: () => string | undefined;
	readonly checkGh: () => "ok" | "missing" | "logged-out";
	readonly render: (sanitize: <T>(value: T) => T) => string;
	readonly context: ShareRedactionContext;
	readonly ask: (preview: string, options: ShareAskOptions) => Promise<ShareDecision>;
	readonly showReviewCopy: (path: string) => void;
	readonly upload: (html: string) => Promise<ShareUploadResult>;
	readonly viewerBase: string | undefined;
}

export type ShareOutcome =
	| { readonly kind: "disabled"; readonly reason: string }
	| { readonly kind: "gh-missing" }
	| { readonly kind: "gh-logged-out" }
	| { readonly kind: "export-failed"; readonly message: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "upload-failed"; readonly message: string }
	| { readonly kind: "shared"; readonly gistUrl: string; readonly viewerUrl: string | undefined };

export interface PreparedShare {
	readonly html: string;
	readonly sha256: string;
	readonly tally: ShareRedactionTally;
	readonly includesOutputs: boolean;
	readonly omittedOutputs: number;
}

export function prepareShare(
	render: ShareDependencies["render"],
	context: ShareRedactionContext,
	includeOutputs = false,
): PreparedShare {
	const tally: ShareRedactionTally = new Map();
	let omittedOutputs = 0;
	const html = render((value) => {
		if (includeOutputs) return redactShareValue(value, context, tally);
		const omissions = newOutputOmissions();
		const projected = omitToolOutputs(value, omissions);
		omittedOutputs = Math.max(omittedOutputs, omissions.count);
		return redactShareValue(projected, context, tally);
	});
	const sha256 = createHash("sha256").update(html).digest("hex");
	return { html, sha256, tally, includesOutputs: includeOutputs, omittedOutputs };
}

const CATEGORY_ORDER: ReadonlyArray<ShareRedactionCategory> = [
	"credential",
	"private key",
	"home path",
	"user name",
	"host name",
	"email",
	"ip address",
	"image",
];

function describeTally(tally: ShareRedactionTally): string {
	const parts = CATEGORY_ORDER.flatMap((category) => {
		const total = tally.get(category) ?? 0;
		return total === 0 ? [] : [`${total} ${category}${total === 1 ? "" : "s"}`];
	});
	return parts.length === 0 ? "nothing matched the redaction rules" : parts.join(", ");
}

export function describeShare(prepared: PreparedShare, viewerBase: string | undefined): string {
	const kilobytes = Math.max(1, Math.round(Buffer.byteLength(prepared.html) / 1024));
	const viewer =
		viewerBase === undefined
			? "No viewer is configured, so you get the gist link only."
			: `The link opens in ${viewerBase}, a viewer set by SHARE_VIEWER_URL that receives the gist id.`;
	return [
		"Share this session as a secret GitHub gist?",
		"",
		prepared.includesOutputs
			? `Uploads: the conversation, tool calls AND their outputs, system prompt and tool list, as one HTML file (${kilobytes} KB, sha256 ${prepared.sha256.slice(0, 12)}).`
			: `Uploads: your messages and the replies, tool names and arguments (including any file content the agent wrote or edited), system prompt and tool list, as one HTML file (${kilobytes} KB, sha256 ${prepared.sha256.slice(0, 12)}).`,
		prepared.includesOutputs
			? "Tool outputs are included (file contents, command output, extension messages)."
			: `Tool outputs are left out: ${prepared.omittedOutputs} replaced by "[output omitted]".`,
		`Removed first: ${describeTally(prepared.tally)}. Images are always left out.`,
		"Who can read it: anyone with the link. A secret gist is unlisted, not private, and stays until you delete it on GitHub.",
		viewer,
		"Redaction is pattern-based and can miss things; review the exact file if the session holds anything sensitive.",
	].join("\n");
}

function parseGistUrl(stdout: string): string | undefined {
	const url = stdout
		.trim()
		.split(/\s+/)
		.find((token) => token.startsWith("https://"));
	return url?.split("/").pop() ? url : undefined;
}

/**
 * `/share` end to end (#3524): nothing is uploaded until the user has seen a
 * description of the exact redacted bytes and chosen Upload. Tool outputs stay
 * out unless the user includes them, which re-renders and re-asks. A review copy is
 * written only on request, into a private temporary directory that is removed
 * on every exit path.
 */
export async function runShare(deps: ShareDependencies): Promise<ShareOutcome> {
	const reason = deps.disabledReason();
	if (reason !== undefined) return { kind: "disabled", reason };
	const gh = deps.checkGh();
	if (gh === "missing") return { kind: "gh-missing" };
	if (gh === "logged-out") return { kind: "gh-logged-out" };

	let prepared: PreparedShare;
	try {
		prepared = prepareShare(deps.render, deps.context);
	} catch (error: unknown) {
		return { kind: "export-failed", message: error instanceof Error ? error.message : String(error) };
	}

	let reviewDir: string | undefined;
	try {
		for (;;) {
			const omittedOutputs = prepared.includesOutputs ? 0 : prepared.omittedOutputs;
			const options = { omittedOutputs, includesOutputs: prepared.includesOutputs };
			const decision = await deps.ask(describeShare(prepared, deps.viewerBase), options);
			if (decision === "cancel") return { kind: "cancelled" };
			if (decision === "upload") break;
			if (decision === "include-outputs" || decision === "exclude-outputs") {
				const include = decision === "include-outputs";
				if (include ? omittedOutputs === 0 : !prepared.includesOutputs) continue;
				try {
					prepared = prepareShare(deps.render, deps.context, include);
				} catch (error: unknown) {
					return { kind: "export-failed", message: error instanceof Error ? error.message : String(error) };
				}
				continue;
			}
			reviewDir ??= mkdtempSync(join(tmpdir(), "senpi-share-"));
			const reviewPath = join(reviewDir, "session.html");
			writeFileSync(reviewPath, prepared.html, { encoding: "utf8", mode: 0o600, flag: "w" });
			deps.showReviewCopy(reviewPath);
		}

		const result = await deps.upload(prepared.html);
		if (result.aborted) return { kind: "cancelled" };
		if (result.code !== 0) return { kind: "upload-failed", message: result.stderr.trim() || "Unknown error" };
		const gistUrl = parseGistUrl(result.stdout);
		if (gistUrl === undefined) return { kind: "upload-failed", message: "Failed to parse gist URL from gh output" };
		const gistId = gistUrl.split("/").pop() ?? "";
		const viewerUrl = deps.viewerBase === undefined ? undefined : `${deps.viewerBase}#${gistId}`;
		return { kind: "shared", gistUrl, viewerUrl };
	} finally {
		if (reviewDir !== undefined) rmSync(reviewDir, { recursive: true, force: true });
	}
}
