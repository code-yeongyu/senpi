/**
 * Lazy boundary for the results-page HTML parser.
 *
 * `html-document.ts` pulls in linkedom, which the CLI must not load at start: nothing needs it until a keyless
 * engine returns a results page. The module loads on the first parse instead; every caller is already async.
 *
 * Follows the repository's documented lazy-boundary pattern (`packages/ai/src/api/*.lazy.ts`,
 * `webfetch/webfetch/content.lazy.ts`); `test/startup-import-graph.test.ts` fails if a static edge to linkedom
 * reappears.
 */

const loadHtmlDocumentModule = () => import("./html-document.ts");

export async function parseHtmlDocument(html: string): Promise<Document> {
	return (await loadHtmlDocumentModule()).parseHtmlDocument(html);
}
