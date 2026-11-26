// Keep displayed search hits aligned with the server's word and phrase matchers.
const tokenPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
const singleToken = /^[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?$/u;
const regexEscape = (part:string) => Array.from(part, c => '[\\^$.*+?()[]{}|]'.includes(c) ? '\\'+c : c).join('');

export function searchRanges(text:string, term:string): {start:number;end:number}[] {
  if (!term.trim()) return [];
  if (singleToken.test(term)) {
    return [...text.matchAll(tokenPattern)].filter(m=>m[0].toLowerCase()===term.toLowerCase()).map(m=>({start:m.index!,end:m.index!+m[0].length}));
  }
  const phrase = term.trim().split(/\s+/).map(regexEscape).join('\\s+');
  const words = '[\\p{L}\\p{N}_]';
  const pattern = new RegExp('(?<!'+words+')'+phrase+'(?!'+words+')','giu');
  return [...text.matchAll(pattern)].map(m=>({start:m.index!,end:m.index!+m[0].length}));
}
