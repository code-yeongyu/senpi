/**
 * Keep retained ID tokens out of terminal output and notification transcripts.
 * The hint-free URL remains usable for manual authorization (with an account
 * selector); browser launchers should receive the original URL.
 */
export function redactOAuthUrl(value: string): string {
	const url = new URL(value);
	if (!url.searchParams.has("id_token_hint")) return value;
	url.searchParams.delete("id_token_hint");
	return url.toString();
}
