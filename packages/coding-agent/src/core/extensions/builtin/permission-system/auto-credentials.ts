const CREDENTIAL_PATH_PATTERNS: readonly RegExp[] = [
	/(^|[/\\=])\.(ssh|aws|gnupg|kube|docker|azure|gcloud)([/\\]|$)/i,
	/(^|[/\\=])\.config[/\\](gh|gcloud|hub|op)([/\\]|$)/i,
	/(^|[/\\=])\.(netrc|npmrc|pypirc|pgpass|git-credentials|htpasswd|vault-token|envrc|terraformrc)$/i,
	/(^|[/\\=])\.env(\.[^/\\]*)?$/i,
	/(^|[/\\=])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
	/(^|[/\\=])\.?credentials(\.json|\.toml|\.tfrc\.json)?$/i,
	/(^|[/\\=])auth\.json$/i,
	/(^|[/\\=])(\.[a-z]+_history|fish_history)$/i,
	/(^|[/\\=])\.m2[/\\]settings\.xml$/i,
	/(^|[/\\])Library[/\\]Keychains([/\\]|$)/i,
];

export function isCredentialPath(value: string): boolean {
	return CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(value));
}
