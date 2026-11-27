// Keep displayed search hits aligned with the server's word and phrase matchers.
const tokenPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
const singleToken = /^[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?$/u;

export function highlightRanges(text: string, quote: string, term = false): { start: number; end: number }[] {
  if (!quote) return [];
  if (!term) {
    const start = text.indexOf(quote);
    return start < 0 ? [] : [{ start, end: start + quote.length }];
  }
  if (!quote.trim()) return [];
  let matches;
  if (singleToken.test(quote)) {
    const lowerTerm = quote.toLowerCase();
    matches = [...text.matchAll(tokenPattern)].filter((match) => match[0].toLowerCase() === lowerTerm);
  } else {
    const phrase = quote.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).join('\\s+');
    const words = '[\\p{L}\\p{N}_]';
    matches = text.matchAll(new RegExp('(?<!' + words + ')' + phrase + '(?!' + words + ')', 'giu'));
  }
  return Array.from(matches, (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}
