const natural = require('natural');
const { franc } = require('franc');
const OpenAI = require('openai');

const porter = natural.PorterStemmer;

const DOMAIN_SYNONYMS = {
	'brand kit': ['brand assets', 'brand styles', 'brand guidelines', 'brand library', 'branding kit'],
	'branding': ['brand kit', 'brand assets', 'brand styles'],
	'logo': ['logomark', 'brand logo'],
	'font': ['typeface', 'typography', 'text style'],
	'color palette': ['brand colors', 'theme colors', 'palette'],
	'caption': ['subtitles', 'auto captions', 'transcript'],
	'pdf': ['portable document', 'pdf export', 'pdf import'],
	'background removal': ['remove background', 'bg removal', 'background eraser'],
	'export': ['download', 'save as', 'render'],
	'resize': ['resizing', 'scale', 'dimensions'],
	'watermark': ['logo overlay', 'stamp'],
	'compress': ['compression', 'reduce size'],
	'crop': ['trim'],
	'merge': ['combine', 'append'],
	'collaborate': ['share', 'invite', 'comments'],
	'template': ['preset', 'layout template', 'design template'],
};

function uniq(array) {
	return Array.from(new Set(array));
}

function normalizeBasic(text) {
	if (!text) return '';
	return text
		.replace(/\s+/g, ' ')
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.trim();
}

function detectLanguageIso3(text) {
	try {
		const lang = franc(text || '', { minLength: 10 });
		return lang; // 'eng' etc.
	} catch (_) {
		return 'und';
	}
}

function normalizeForMatch(text) {
	const basic = normalizeBasic(text).toLowerCase();
	const lang = detectLanguageIso3(basic);
	if (lang === 'eng') {
		// Tokenize words and stem English
		const tokens = basic.replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
		const stems = tokens.map(t => porter.stem(t));
		return {
			lang,
			plain: basic,
			tokens,
			stems,
		};
	}
	return {
		lang,
		plain: basic,
		tokens: basic.split(/\s+/).filter(Boolean),
		stems: [],
	};
}

function expandWithSynonyms(terms, useSynonyms) {
	if (!useSynonyms) return uniq(terms);
	const expanded = [];
	for (const t of terms) {
		expanded.push(t);
		const syns = DOMAIN_SYNONYMS[t.toLowerCase()];
		if (syns) expanded.push(...syns);
	}
	return uniq(expanded);
}

function buildRegexForTerm(term) {
	// If space present, treat as phrase; else word boundary
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (term.includes(' ')) {
		return new RegExp(escaped.replace(/\s+/g, '\\s+'), 'i');
	}
	return new RegExp(`\\b${escaped}\\b`, 'i');
}

function proximityScore(tokens, terms, windowSize = 6) {
	// Simple proximity: if any two different terms occur within window, score += 1
	const positionsByTerm = new Map();
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i].toLowerCase();
		for (const t of terms) {
			const tFirst = t.split(' ')[0].toLowerCase();
			if (tok === tFirst) {
				if (!positionsByTerm.has(t)) positionsByTerm.set(t, []);
				positionsByTerm.get(t).push(i);
			}
		}
	}
	const termsArr = Array.from(positionsByTerm.keys());
	let best = 0;
	for (let i = 0; i < termsArr.length; i++) {
		for (let j = i + 1; j < termsArr.length; j++) {
			const a = positionsByTerm.get(termsArr[i]) || [];
			const b = positionsByTerm.get(termsArr[j]) || [];
			for (const pa of a) for (const pb of b) {
				const dist = Math.abs(pa - pb);
				if (dist <= windowSize) best = Math.max(best, windowSize - dist + 1);
			}
		}
	}
	return best;
}

async function getOpenAIClient() {
	const key = process.env.OPENAI_API_KEY;
	if (!key) return null;
	try {
		return new OpenAI({ apiKey: key });
	} catch (_) {
		return null;
	}
}

async function embedText(openai, text) {
	if (!openai) return null;
	const t = normalizeBasic(text).slice(0, 8000);
	const res = await openai.embeddings.create({ model: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small', input: t });
	return res.data[0]?.embedding || null;
}

function cosineSim(a, b) {
	if (!a || !b) return 0;
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (!na || !nb) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function prepareQueryContext(query) {
	const useSynonyms = !!query.useSynonyms;
	const must = expandWithSynonyms(query.must || [], useSynonyms);
	const optional = expandWithSynonyms(query.optional || [], useSynonyms);
	const exclude = expandWithSynonyms(query.exclude || [], useSynonyms);
	const featureDef = normalizeBasic(query.featureDef || '');

	const openai = query.useSemantic ? await getOpenAIClient() : null;
	let featureEmbedding = null;
	if (openai && featureDef) {
		try { featureEmbedding = await embedText(openai, featureDef); } catch (_) {}
	}

	return { useSynonyms, useSemantic: !!query.useSemantic, must, optional, exclude, featureDef, openai, featureEmbedding };
}

function lexicalMatch(normalized, ctx) {
	const why = [];
	// Exclude check
	for (const term of ctx.exclude) {
		const re = buildRegexForTerm(term);
		if (re.test(normalized.plain)) return { pass: false, why: [`Excluded: ${term}`] };
	}
	// Must check (all)
	for (const term of ctx.must) {
		const re = buildRegexForTerm(term);
		if (!re.test(normalized.plain)) return { pass: false, why: [`Missing must: ${term}`] };
		why.push(`Must hit: ${term}`);
	}
	// Optional check (any)
	let optionalHits = [];
	for (const term of ctx.optional) {
		const re = buildRegexForTerm(term);
		if (re.test(normalized.plain)) optionalHits.push(term);
	}
	if (ctx.optional.length > 0 && optionalHits.length === 0 && ctx.must.length === 0) {
		// If only optional provided, require at least one
		return { pass: false, why: ['No optional keywords matched'] };
	}
	if (optionalHits.length) why.push(`Optional hits: ${optionalHits.join(', ')}`);
	// Proximity bonus
	const prox = proximityScore(normalized.tokens, [...ctx.must, ...ctx.optional]);
	if (prox > 0) why.push(`Proximity bonus: ${prox}`);
	return { pass: true, why };
}

async function semanticGate(text, ctx) {
	if (!ctx.useSemantic) return { pass: true, score: 0 };
	if (!ctx.openai) return { pass: false, score: 0 };
	const threshold = Number(process.env.SEMANTIC_THRESHOLD || 0.78);
	let queryEmbed = ctx.featureEmbedding;
	if (!queryEmbed) {
		// fallback: build from terms
		const intent = [...ctx.must, ...ctx.optional].join(', ');
		if (!intent) return { pass: false, score: 0 };
		try { queryEmbed = await embedText(ctx.openai, intent); } catch (_) { return { pass: false, score: 0 }; }
	}
	let itemEmbed = null;
	try { itemEmbed = await embedText(ctx.openai, text); } catch (_) { return { pass: false, score: 0 }; }
	const score = cosineSim(queryEmbed, itemEmbed);
	return { pass: score >= threshold, score };
}

async function matchItem(text, ctx) {
	const norm = normalizeForMatch(text || '');
	const lex = lexicalMatch(norm, ctx);
	if (!lex.pass) return { isMatch: false, why: lex.why.join(' | '), score: 0 };
	if (!ctx.useSemantic) return { isMatch: true, why: lex.why.join(' | '), score: 1 };
	const sem = await semanticGate(text, ctx);
	if (!sem.pass) return { isMatch: false, why: `${lex.why.join(' | ')} | Semantic score ${sem.score.toFixed(2)} below threshold`, score: sem.score };
	return { isMatch: true, why: `${lex.why.join(' | ')} | Semantic score ${sem.score.toFixed(2)}`, score: sem.score };
}

module.exports = { prepareQueryContext, matchItem };
