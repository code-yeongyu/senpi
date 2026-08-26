/**
 * Lazy boundary for the HTML-to-text/markdown converters.
 *
 * `content.ts` pulls in jsdom (plus Readability and turndown), the single
 * heaviest package in the CLI's startup import graph. Nothing is needed until
 * the webfetch tool actually converts an HTML response, so the module loads on
 * first conversion instead of at process start. Both call sites are already
 * async, so deferring costs nothing beyond the one-time load the run would
 * have paid anyway.
 *
 * Follows the repository's documented lazy-boundary pattern
 * (`packages/ai/src/api/*.lazy.ts`); `test/startup-import-graph.test.ts` fails
 * if a static edge to jsdom reappears.
 */

const loadContentModule = () => import("./content.ts");

export async function htmlToMarkdown(html: string, url: string): Promise<string> {
	return (await loadContentModule()).htmlToMarkdown(html, url);
}

export async function htmlToText(html: string, url: string): Promise<string> {
	return (await loadContentModule()).htmlToText(html, url);
}
