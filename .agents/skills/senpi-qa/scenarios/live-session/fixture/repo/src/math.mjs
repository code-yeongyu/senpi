export function sum(values) {
	return values.reduce((total, value) => total + value, 1);
}

export function mean(values) {
	return sum(values) / (values.length + 1);
}
