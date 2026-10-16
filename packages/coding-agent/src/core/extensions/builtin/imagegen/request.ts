import type { AssistantImages } from "@earendil-works/pi-ai/compat";
import type { ImageGenCandidate } from "./auth.ts";

export interface SkippedImageProvider {
	providerId: string;
	baseUrl: string;
	httpStatus: number;
}

export type ImageRequestOutcome =
	| { kind: "images"; auth: ImageGenCandidate; images: AssistantImages; skipped: readonly SkippedImageProvider[] }
	| { kind: "exhausted"; skipped: readonly SkippedImageProvider[] };

const NO_IMAGES_ENDPOINT_STATUSES: ReadonlySet<number> = new Set([404, 405]);

function missingImagesEndpointStatus(images: AssistantImages): number | undefined {
	if (images.stopReason !== "error") return undefined;
	const status = images.providerDiagnostic?.httpStatus;
	return status !== undefined && NO_IMAGES_ENDPOINT_STATUSES.has(status) ? status : undefined;
}

/**
 * Sends the request to `first`, then moves to the next candidate only while the current one is a
 * scanned gateway whose server reports no images endpoint (HTTP 404/405, read from the structured
 * provider diagnostic, never from message text). Any other result, success or failure, is final.
 */
export async function requestImagesAcrossCandidates(
	first: ImageGenCandidate,
	rest: AsyncIterator<ImageGenCandidate>,
	request: (auth: ImageGenCandidate) => Promise<AssistantImages>,
): Promise<ImageRequestOutcome> {
	const skipped: SkippedImageProvider[] = [];
	let auth = first;
	for (;;) {
		const images = await request(auth);
		const status = auth.fallthrough ? missingImagesEndpointStatus(images) : undefined;
		if (status === undefined) return { kind: "images", auth, images, skipped };
		skipped.push({ providerId: auth.providerId ?? "openai", baseUrl: auth.baseUrl, httpStatus: status });
		const next = await rest.next();
		if (next.done) return { kind: "exhausted", skipped };
		auth = next.value;
	}
}

function describe(skipped: readonly SkippedImageProvider[]): string {
	return skipped.map((entry) => `${entry.providerId} (${entry.baseUrl}, HTTP ${entry.httpStatus})`).join(", ");
}

export function exhaustedProvidersMessage(skipped: readonly SkippedImageProvider[]): string {
	return [
		`Error: none of the configured OpenAI-compatible providers serves image generation. Tried: ${describe(skipped)}.`,
		'Set PI_IMAGE_GEN_PROVIDER to a provider whose endpoint has /images, override the "openai" provider in models.json with such a baseUrl, or store an OpenAI API key for provider "openai".',
	].join(" ");
}

export function skippedProvidersNote(skipped: readonly SkippedImageProvider[]): string | undefined {
	if (skipped.length === 0) return undefined;
	return `Note: skipped ${describe(skipped)}: no image generation endpoint. Pin a provider with PI_IMAGE_GEN_PROVIDER to skip this check.`;
}
