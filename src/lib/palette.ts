/**
 * Matching for the ⌘K palette: every whitespace-separated query token must
 * appear in the item text, as a substring (best) or as an in-order
 * subsequence (e.g. "fbs" -> "fitbase"). Lower score = better match.
 */
export function matchScore(query: string, text: string): number | null {
	const hay = text.toLowerCase();
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	let score = 0;
	for (const token of tokens) {
		const idx = hay.indexOf(token);
		if (idx >= 0) {
			// Prefer matches at the start of a word.
			const atWord = idx === 0 || /[\s·\-_/.]/.test(hay[idx - 1] ?? "");
			score += atWord ? idx / 100 : 1 + idx / 100;
			continue;
		}
		let pos = -1;
		for (const ch of token) {
			pos = hay.indexOf(ch, pos + 1);
			if (pos < 0) return null;
		}
		score += 5;
	}
	return score;
}

export function rank<T extends { text: string }>(items: T[], query: string) {
	if (!query.trim()) return items;
	return items
		.map((item, i) => ({ item, i, score: matchScore(query, item.text) }))
		.filter((x): x is { item: T; i: number; score: number } => x.score !== null)
		.sort((a, b) => a.score - b.score || a.i - b.i)
		.map((x) => x.item);
}
