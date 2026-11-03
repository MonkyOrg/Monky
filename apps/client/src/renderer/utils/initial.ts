const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Primeiro caractere visível do nome (emoji incluso), sem partir pares substitutos ao meio. */
export function firstInitial(text: string | null | undefined, fallback = '?'): string {
  const first = segmenter.segment((text ?? '').trim())[Symbol.iterator]().next().value;
  return first ? first.segment.toUpperCase() : fallback;
}
