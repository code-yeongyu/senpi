import { processSingleton } from "./process-singleton.ts";

/**
 * Product shown on the local sign-in result pages. The host that runs the engine sets it once at
 * startup (the coding agent passes its `SENPI_BRAND` profile); without it the pages carry no product
 * mark at all.
 */
export interface OAuthPageBrand {
	readonly name: string;
	/** A base64 image data URI (`data:image/svg+xml;base64,...`, PNG, WebP or JPEG); anything else is dropped. */
	readonly logo?: string;
}

// Process-wide so the self-contained login chunks of the release bundle read the same value (#2334).
const brandSlot = processSingleton<{ current: OAuthPageBrand | undefined }>(
	"@code-yeongyu/senpi-ai:oauth-page-brand",
	() => ({ current: undefined }),
);

// The logo lands in an <img src>, which never runs scripts; the base64 alphabet cannot close the attribute.
const LOGO_DATA_URI = /^data:image\/(?:svg\+xml|png|webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Sets the product shown on the sign-in result pages. An empty name clears it. */
export function setOAuthPageBrand(brand: OAuthPageBrand | undefined): void {
	const name = brand?.name.trim();
	if (!brand || !name) {
		brandSlot.current = undefined;
		return;
	}
	const logo = brand.logo && LOGO_DATA_URI.test(brand.logo) ? brand.logo : undefined;
	brandSlot.current = logo ? { name, logo } : { name };
}

/** exported for tests only */
export function resetOAuthPageBrandForTests(): void {
	brandSlot.current = undefined;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;
	const brand = brandSlot.current;
	const logo = brand?.logo ? `<img class="logo" src="${brand.logo}" alt="" />` : "";
	const brandName = brand ? `<div class="brand-name">${escapeHtml(brand.name)}</div>` : "";

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 16px;
    }
    .brand-name {
      margin-bottom: 24px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--text-dim);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    ${logo}
    ${brandName}
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	});
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
	});
}
