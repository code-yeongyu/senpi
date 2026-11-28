import { WebfetchSourceDeniedError } from "./errors.ts";

// Markup a bot-challenge interstitial carries (Cloudflare, reCAPTCHA, hCaptcha, PerimeterX, DataDome) and the titles
// such pages use. Either counts only on a short page, so an article that discusses CAPTCHAs stays source content.
const CHALLENGE_MARKUP =
	/cf-challenge|challenge-platform|__cf_chl_|cf_chl_opt|g-recaptcha|h-captcha|px-captcha|captcha-delivery\.com|datadome/i;
const CHALLENGE_TITLE =
	/<title[^>]*>\s*(?:just a moment|attention required|access denied|verify you are human|are you a robot|security check)/i;
const MAX_CHALLENGE_TEXT_CHARS = 2000;
const MAX_EXCERPT_CHARS = 400;

export interface FetchedSource {
	readonly url: string;
	readonly finalUrl: string;
	readonly status: number;
	readonly raw: string;
	readonly isHtml: boolean;
	readonly text: string;
	readonly emptyExplained: boolean;
}

export function assertSourceRetrieved(source: FetchedSource): void {
	const reason = denialReason(source);
	if (reason === undefined) return;
	const where = source.finalUrl === source.url ? source.url : `${source.url} (final URL ${source.finalUrl})`;
	const excerpt = visibleText(source).replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS);
	throw new WebfetchSourceDeniedError(
		[
			`Failed source: ${where} was not retrieved: ${reason}.`,
			"The response is not source content: do not cite or summarize it as fetched, and tell the user this source could not be read.",
			...(excerpt === ""
				? []
				: [`Diagnostic excerpt of the response (not source content): ${JSON.stringify(excerpt)}`]),
		].join("\n"),
	);
}

function denialReason(source: FetchedSource): string | undefined {
	const visible = visibleText(source);
	const challenge =
		source.isHtml &&
		visible.length <= MAX_CHALLENGE_TEXT_CHARS &&
		(CHALLENGE_MARKUP.test(source.raw) || CHALLENGE_TITLE.test(source.raw));
	if (challenge) return `HTTP ${source.status}, bot challenge`;
	if (source.status === 429) return "HTTP 429, rate limited";
	if (source.status === 401 || source.status === 403) return `HTTP ${source.status}, access denied`;
	if (source.status >= 400) return `HTTP ${source.status}, request failed`;
	if (visible.trim() === "" && !source.emptyExplained) return `HTTP ${source.status}, no readable content`;
	return undefined;
}

function visibleText(source: FetchedSource): string {
	if (!source.isHtml || source.text !== source.raw) return source.text;
	return source.raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>|<[^>]+>/gi, " ");
}
