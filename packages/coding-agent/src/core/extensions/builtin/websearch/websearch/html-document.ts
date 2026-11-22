import { parseHTML } from "linkedom";

export function parseHtmlDocument(html: string): Document {
	return parseHTML(html).document;
}
