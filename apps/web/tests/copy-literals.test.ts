import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// SPEC 0.2-4 and 18.1: screen text comes from the copy module (`src/copy.ts`), never from literals in screen code.
const source = fileURLToPath(new URL('../src/', import.meta.url));
const hangul = /[ㄱ-ㆎ가-힣]/;

/**
 * Data that is not screen copy. Each entry is one file and one exact literal; a literal that moves or disappears
 * makes the test fail so the list cannot go stale.
 */
const allowed: Record<string, readonly string[]> = {
  // The browser demo family (F-20): names, places and the example GPS label are fixture data.
  'demo-domain.ts': [
    '역삼동 근처', '우리 가족', '엄마', '아빠', '이모', '민준', '서연', '할머니',
    '수학학원', '학원', '학교', '집', '피아노', '정문', '후문 주차장', '후문 벤치 앞', '우리 차',
  ],
  // Place kinds saved by the demo before the server's English kinds; used only as lookup keys.
  'guardian.tsx': ['학원', '학교'],
};

type Token = { kind: 'string' | 'template' | 'regex' | 'jsx'; text: string; line: number };

/** Lists string, template, regex and JSX-text tokens that contain Hangul. Comments are skipped. */
export function hangulTokens(code: string): Token[] {
  const found: Token[] = [];
  const lineAt = (index: number) => code.slice(0, index).split('\n').length;
  const report = (kind: Token['kind'], start: number, end: number, text = code.slice(start, end)) => {
    if (hangul.test(text)) found.push({ kind, text, line: lineAt(start) });
  };
  // Braces opened by `${` inside templates, so `}` can return to the template text.
  const templateDepths: number[] = [];
  let depth = 0;
  let previous = '';
  let index = 0;

  function readQuoted(quote: string) {
    const start = index;
    index++;
    while (index < code.length && code[index] !== quote && code[index] !== '\n') index += code[index] === '\\' ? 2 : 1;
    index++;
    report('string', start + 1, index - 1);
  }
  function readTemplate(start: number) {
    // Reads template text up to the closing backtick or the next `${`.
    while (index < code.length) {
      const char = code[index];
      if (char === '\\') { index += 2; continue; }
      if (char === '`') {
        index++;
        report('template', start, index - 1);
        return;
      }
      if (char === '$' && code[index + 1] === '{') {
        report('template', start, index);
        index += 2;
        templateDepths.push(depth);
        depth++;
        return;
      }
      index++;
    }
  }
  function regexAllowed() {
    return previous === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(previous) || /\b(return|typeof|case|in|of|delete|void|throw|new)$/.test(previous);
  }
  function readRegex() {
    const start = index;
    let inClass = false;
    index++;
    while (index < code.length && code[index] !== '\n') {
      const char = code[index];
      if (char === '\\') { index += 2; continue; }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        index++;
        report('regex', start, index);
        return true;
      }
      index++;
    }
    index = start;
    return false;
  }

  while (index < code.length) {
    const char = code[index];
    const nextChar = code[index + 1];
    if (char === '/' && nextChar === '/') {
      while (index < code.length && code[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && nextChar === '*') {
      const end = code.indexOf('*/', index + 2);
      index = end < 0 ? code.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      readQuoted(char);
      previous = 'x';
      continue;
    }
    if (char === '`') {
      index++;
      readTemplate(index);
      previous = 'x';
      continue;
    }
    if (char === '}' && templateDepths.length && templateDepths[templateDepths.length - 1] === depth - 1) {
      templateDepths.pop();
      depth--;
      index++;
      readTemplate(index);
      previous = 'x';
      continue;
    }
    // `</tag` and `/>` are JSX, not regular expressions.
    if (char === '/' && previous !== '<' && nextChar !== '>' && regexAllowed() && readRegex()) {
      previous = 'x';
      continue;
    }
    if (hangul.test(char)) {
      // Text between JSX tags or braces on this line.
      let start = index;
      let end = index;
      while (start > 0 && !/[<>{}\n]/.test(code[start - 1])) start--;
      while (end < code.length && !/[<>{}\n]/.test(code[end])) end++;
      report('jsx', start, end, code.slice(start, end).trim());
      index = end;
      previous = 'x';
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (!/\s/.test(char)) previous = /[\w$]/.test(char) ? (/[\w$]/.test(previous.slice(-1)) ? previous + char : char) : char;
    index++;
  }
  return found;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test('the guard finds Hangul in strings, templates and JSX text but not in comments', () => {
  const sample = [
    '// 주석은 무시해요',
    '/* 블록 주석 */',
    "const a = '문구';",
    'const b = `시간 ${value}초`;',
    'const c = <p>안녕 {name}</p>;',
    'const d = value / 2 / 3; const e = /[가-힣]/;',
    'const f = <a href="/x" />;',
    'const g = `${`안쪽`} 바깥`;',
  ].join('\n');
  assert.deepEqual(hangulTokens(sample).map(({ kind, text }) => [kind, text]), [
    ['string', '문구'],
    ['template', '시간 '],
    ['template', '초'],
    ['jsx', '안녕'],
    ['regex', '/[가-힣]/'],
    ['template', '안쪽'],
    ['template', ' 바깥'],
  ]);
});

test('screen code takes every Korean string from the copy module', () => {
  const violations: string[] = [];
  const unused = new Map(Object.entries(allowed).map(([file, literals]) => [file, new Set(literals)]));
  for (const path of sourceFiles(source)) {
    const file = relative(source, path).replaceAll('\\', '/');
    if (file === 'copy.ts') continue;
    for (const token of hangulTokens(readFileSync(path, 'utf8'))) {
      if (token.kind === 'string' && allowed[file]?.includes(token.text)) {
        unused.get(file)?.delete(token.text);
        continue;
      }
      violations.push(`${file}:${token.line} ${token.kind} ${JSON.stringify(token.text)}`);
    }
  }
  assert.deepEqual(violations, [], 'Move these strings into src/copy.ts');
  const stale = Array.from(unused).flatMap(([file, literals]) => Array.from(literals, (literal) => `${file} ${JSON.stringify(literal)}`));
  assert.deepEqual(stale, [], 'Remove allowlist entries that no longer match a literal');
});
