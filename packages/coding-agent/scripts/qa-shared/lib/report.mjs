export function pass(transcript, name) {
	transcript.push(`PASS ${name}`);
	process.stdout.write(`PASS ${name}\n`);
}

export function fail(transcript, name, error) {
	transcript.push(`FAIL ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.stderr.write(`FAIL ${name}\n`);
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}
