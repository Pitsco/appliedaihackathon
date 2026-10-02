// What a call costs, in US dollars per million tokens: [input, output].
// These are list prices as we understood them on build day (2 October 2026). They are
// matched by model-name prefix. To correct or add a price without touching code, set
//   MODEL_PRICES='{"claude-sonnet-5-5":[2,10]}'
// A model with no known price is reported as tokens only, never as a guessed dollar figure.
const LIST = [
  ['claude-haiku-4-5', [1, 5]],
  ['claude-sonnet-5', [2, 10]],
  ['claude-opus-5', [5, 25]],
  ['claude-sonnet-4', [3, 15]],
  ['gpt-4.1-nano', [0.1, 0.4]],
  ['gpt-4.1-mini', [0.4, 1.6]],
  ['gpt-4.1', [2, 8]],
  ['gpt-4o-mini', [0.15, 0.6]],
  ['gpt-4o', [2.5, 10]],
  ['gpt-5-mini', [0.25, 2]],
  ['gpt-5', [1.25, 10]],
];

let overrides = {};
try {
  overrides = JSON.parse(process.env.MODEL_PRICES || '{}');
} catch {
  console.warn('MODEL_PRICES is not valid JSON, ignoring it.');
}

export function priceFor(model) {
  const name = String(model || '');
  for (const [prefix, price] of Object.entries(overrides)) if (name.startsWith(prefix) && Array.isArray(price)) return price;
  for (const [prefix, price] of LIST) if (name.startsWith(prefix)) return price;
  return null;
}

export function costOf(model, inputTokens, outputTokens) {
  const price = priceFor(model);
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}
