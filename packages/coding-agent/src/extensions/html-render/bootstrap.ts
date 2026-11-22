// The theme bootstrap injection and base stylesheet, mirroring the desktop's
// packages/shared/src/htmlRender.ts (upstream t3code #15968). Kept small and
// dependency-light: pure string functions, no Effect, no server. A page the
// agent writes here is the same shape the desktop stores on publish.

const BASE_CSS =
	"html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
	"html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

const DARK_VARS: Record<string, string> = {
	"--background": "#0a0a0a",
	"--foreground": "#f5f5f5",
	"--muted-foreground": "#818181",
	"--chart-1": "#60a5fa",
	"--font-sans": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
	"--font-mono": '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
	"--radius": "0.625rem",
};

const LIGHT_VARS: Record<string, string> = {
	...DARK_VARS,
	"--background": "#ffffff",
	"--foreground": "#0a0a0a",
	"--muted-foreground": "#525252",
	"--chart-1": "#1d4ed8",
};

function rootRule(appearance: "light" | "dark", variables: Record<string, string>): string {
	const declarations = Object.entries(variables)
		.map(([name, value]) => `${name}:${value};`)
		.join("");
	return `:root{color-scheme:${appearance};${declarations}}`;
}

const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("t3-theme");if(!s)return;var b=${JSON.stringify(BASE_CSS)};try{var m=window.matchMedia("(prefers-color-scheme: light)");var a=function(){s.textContent=m.matches?${JSON.stringify(rootRule("light", LIGHT_VARS))}:${JSON.stringify(rootRule("dark", DARK_VARS))}+b;};a();if(m.addEventListener)m.addEventListener("change",a);}catch(e){}})();`;

function bootstrapMarkup(markup: string): string {
	const defaultCss = `${rootRule("dark", DARK_VARS)}@media (prefers-color-scheme: light){${rootRule("light", LIGHT_VARS)}}${BASE_CSS}`;
	return [
		/<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
		/<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
			? ""
			: '<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<style id="t3-theme">${defaultCss}</style>`,
		`<script>${BOOTSTRAP_SCRIPT}</script>`,
	].join("");
}

const blankNonMarkup = (html: string) => {
	const scan = html.replace(
		/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
		(match) => " ".repeat(match.length),
	);
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	let at = 0;
	for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
		if (!match[1]) {
			if (depth++ === 0) start = match.index;
		} else if (depth > 0 && --depth === 0) {
			const end = match.index + match[0].length;
			parts.push(scan.slice(at, start), " ".repeat(end - start));
			at = end;
		}
	}
	if (depth > 0) {
		parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
		at = scan.length;
	}
	parts.push(scan.slice(at));
	return parts.join("");
};

/**
 * A page is a static snapshot: everything it shows is in the document (inline,
 * data: or blob:), and it reaches no network. Its scripts run whenever it
 * opens, but fetch, XHR, WebSocket, EventSource, remote scripts, styles,
 * images and fonts, frames, form posts and <base> are refused. The policy is
 * the document's first element, so nothing the page writes loads before it.
 * Mirrors the desktop's packages/shared/src/htmlRenderBootstrap.ts.
 */
export const HTML_RENDER_CONTENT_SECURITY_POLICY = [
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
	"style-src 'unsafe-inline' data:",
	"img-src data: blob:",
	"font-src data:",
	"media-src data: blob:",
	"worker-src blob:",
	"connect-src 'none'",
	"frame-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CONTENT_SECURITY_POLICY}">`;
// Every written page starts with a UTF-8 byte order mark, a standards-mode
// doctype and the policy, in that order and in plain ASCII. The mark makes the
// browser decode the file as UTF-8 whatever charset the page declares, so no
// declared encoding can turn the policy into text, and nothing the page wrote
// comes before it. A leading doctype of the page's own is dropped only when it is
// printable ASCII; anything else stays where it is, after the policy, where the
// parser ignores a doctype.
const PREAMBLE = `\uFEFF<!doctype html>${POLICY_META}`;
const LEADING_ASCII_DOCTYPE = /^\uFEFF?[\t\n\f\r ]*<!doctype[ -=?-~]*>/i;

/**
 * Inserts the theme bootstrap at the start of the document head, and the
 * snapshot policy ahead of everything the page wrote.
 */
export function injectHtmlRenderBootstrap(html: string): string {
	return PREAMBLE + injectThemeBootstrap(html).replace(LEADING_ASCII_DOCTYPE, "");
}

function injectThemeBootstrap(html: string): string {
	const scan = blankNonMarkup(html);
	const markup = bootstrapMarkup(scan);
	const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
	if (headOpen) {
		const at = headOpen.index + headOpen[0].length;
		return html.slice(0, at) + markup + html.slice(at);
	}
	const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
	if (htmlOpen) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
	}
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
	if (doctype) {
		const at = doctype[0].length;
		return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
	}
	return `<!doctype html><head>${markup}</head>${html}`;
}
