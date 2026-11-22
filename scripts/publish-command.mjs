export function buildPublishArgs({ githubActions }) {
	if (!githubActions) {
		throw new Error("GitHub Actions is required for provenance-backed npm publication.");
	}

	const args = ["publish", "--access", "public", "--tag", "latest"];
	args.push("--provenance");
	args.push("--ignore-scripts");
	return args;
}

export function publishPackage({ name, version }, publish, readVersion) {
	try {
		publish();
		return "published";
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const code = /^npm (?:error|ERR!) code (\S+)\s*$/m.exec(message)?.[1];
		if (code !== "EPUBLISHCONFLICT" && (code !== "E409" || !/Cannot publish over/i.test(message))) {
			throw error;
		}

		let visibleVersion;
		try {
			visibleVersion = readVersion(`${name}@${version}`);
		} catch {
			throw error;
		}
		if (visibleVersion !== version) {
			throw error;
		}
		return "already-published";
	}
}
