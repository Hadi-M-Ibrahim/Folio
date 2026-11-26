// Keep displayed search hits aligned with the server's word and phrase matchers.
const tokenPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
const singleToken = /^[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?$/u;

export function searchRanges(text: string, term: string): { start: number; end: number }[] {
  if (!term.trim()) return [];
  let matches;
  if (singleToken.test(term)) {
    const lowerTerm = term.toLowerCase();
    matches = [...text.matchAll(tokenPattern)].filter((match) => match[0].toLowerCase() === lowerTerm);
  } else {
    const phrase = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).join('\\s+');
    const words = '[\\p{L}\\p{N}_]';
    matches = text.matchAll(new RegExp('(?<!' + words + ')' + phrase + '(?!' + words + ')', 'giu'));
  }
  return Array.from(matches, (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}
