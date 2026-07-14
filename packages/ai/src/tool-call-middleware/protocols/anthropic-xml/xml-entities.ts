export function encodeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function encodeXmlLineBreaks(value: string): string {
	return value.replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
}

export function encodeXmlParameterText(value: string): string {
	const encoded = encodeXmlText(value);
	let contentStart = 0;
	while (encoded[contentStart] === "\r" || encoded[contentStart] === "\n") {
		contentStart += 1;
	}

	let contentEnd = encoded.length;
	while (contentEnd > contentStart && (encoded[contentEnd - 1] === "\r" || encoded[contentEnd - 1] === "\n")) {
		contentEnd -= 1;
	}

	return (
		encodeXmlLineBreaks(encoded.slice(0, contentStart)) +
		encoded.slice(contentStart, contentEnd) +
		encodeXmlLineBreaks(encoded.slice(contentEnd))
	);
}

export function encodeXmlAttribute(value: string): string {
	return encodeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function decodeXmlEntities(value: string): string {
	return value
		.replaceAll("&#13;", "\r")
		.replaceAll("&#10;", "\n")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}
