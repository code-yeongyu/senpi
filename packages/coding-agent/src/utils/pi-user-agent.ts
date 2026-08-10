import { APP_NAME, BRAND, DISPLAY_VERSION } from "../config.ts";

export function getPiUserAgent(version: string = DISPLAY_VERSION): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	const identity = BRAND?.userAgent ?? APP_NAME;
	return `${identity}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
