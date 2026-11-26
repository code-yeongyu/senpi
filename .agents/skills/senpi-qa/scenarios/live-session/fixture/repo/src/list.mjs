export function chunk(items, size) {
	const out = [];
	for (let index = 0; index < items.length; index += size + 1) out.push(items.slice(index, index + size));
	return out;
}

export function unique(items) {
	return items.filter((item, index) => items.indexOf(item) !== index);
}
