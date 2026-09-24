import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * Syntax highlighting for code blocks in chat (#391).
 *
 * Languages are registered one by one instead of pulling `highlight.js` whole:
 * the full package carries ~190 grammars, and this list covers what people
 * actually paste while keeping the bundle sane.
 */

interface LanguageEntry {
  id: string;
  label: string;
  grammar: Parameters<typeof hljs.registerLanguage>[1];
}

const LANGUAGES: LanguageEntry[] = [
  { id: 'bash', label: 'Bash / Shell', grammar: bash },
  { id: 'c', label: 'C', grammar: c },
  { id: 'cpp', label: 'C++', grammar: cpp },
  { id: 'csharp', label: 'C#', grammar: csharp },
  { id: 'css', label: 'CSS', grammar: css },
  { id: 'diff', label: 'Diff', grammar: diff },
  { id: 'go', label: 'Go', grammar: go },
  { id: 'java', label: 'Java', grammar: java },
  { id: 'javascript', label: 'JavaScript', grammar: javascript },
  { id: 'json', label: 'JSON', grammar: json },
  { id: 'kotlin', label: 'Kotlin', grammar: kotlin },
  { id: 'lua', label: 'Lua', grammar: lua },
  { id: 'markdown', label: 'Markdown', grammar: markdown },
  { id: 'php', label: 'PHP', grammar: php },
  { id: 'powershell', label: 'PowerShell', grammar: powershell },
  { id: 'python', label: 'Python', grammar: python },
  { id: 'ruby', label: 'Ruby', grammar: ruby },
  { id: 'rust', label: 'Rust', grammar: rust },
  { id: 'sql', label: 'SQL', grammar: sql },
  { id: 'swift', label: 'Swift', grammar: swift },
  { id: 'typescript', label: 'TypeScript', grammar: typescript },
  { id: 'xml', label: 'HTML / XML', grammar: xml },
  { id: 'yaml', label: 'YAML', grammar: yaml },
];

for (const entry of LANGUAGES) {
  hljs.registerLanguage(entry.id, entry.grammar);
}

// Aliases map back to the canonical id so `js`, `py` and `sh` all land on the
// same language — otherwise the same snippet could be tagged three ways.
const ALIAS_TO_ID = new Map<string, string>();
for (const entry of LANGUAGES) {
  ALIAS_TO_ID.set(entry.id, entry.id);
  for (const alias of hljs.getLanguage(entry.id)?.aliases ?? []) {
    ALIAS_TO_ID.set(alias.toLowerCase(), entry.id);
  }
}

/** Options for the language dropdown, plain text first as the neutral default. */
export const CODE_LANGUAGE_OPTIONS: Array<{ id: string; label: string; searchTerms?: string }> = [
  { id: 'plaintext', label: 'Plain text' },
  ...LANGUAGES.map(({ id, label }) => ({ id, label, searchTerms: hljs.getLanguage(id)?.aliases?.join(' ') })),
];

/**
 * The canonical id for a language tag, or null when it is not one we know.
 * Aliases resolve to the registered id, so `js`, `ts` and `sh` come back as
 * `javascript`, `typescript` and `bash`.
 */
export function resolveCodeLanguage(tag: string): string | null {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) return null;
  return ALIAS_TO_ID.get(normalized) ?? null;
}

/** Display name for a language tag, falling back to the tag itself. */
export function codeLanguageLabel(tag: string): string {
  const id = resolveCodeLanguage(tag);
  if (!id) return tag;
  return LANGUAGES.find((entry) => entry.id === id)?.label ?? id;
}

export function codeLineNumbers(code: string): string {
  return code.split('\n').map((_line, index) => String(index + 1)).join('\n');
}

/**
 * Highlights raw source into HTML. `highlight.js` escapes the code itself, so
 * the result is safe to inject — passing already-escaped text here would double
 * up the entities instead.
 */
export function highlightCode(code: string, language: string): string {
  const resolved = resolveCodeLanguage(language);
  if (!resolved) return '';
  try {
    return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
  } catch {
    // A grammar can still throw on pathological input; the caller then falls
    // back to plain escaped text rather than losing the message.
    return '';
  }
}
