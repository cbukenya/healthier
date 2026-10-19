import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';

/**
 * Finds text a person could see that is written into the code rather than taken from the
 * language file. It reads every source file's syntax tree and flags:
 *
 *   - text between JSX tags, and strings or template literals rendered as JSX children;
 *   - strings in JSX attributes a person can see or hear (aria-label, title, alt, …), and any
 *     attribute string that reads as words;
 *   - strings and template literals elsewhere that read as English: two or more words, or a
 *     capitalised word;
 *   - t() calls at module scope, which would translate once, before the language is chosen.
 *
 * It errs on the side of quiet: it skips class lists, CSS, keys, comparisons, imports, types,
 * console and Error messages. A string it can't tell apart can carry an `i18n-ignore` comment
 * on its line or the line before, with the reason.
 */

export interface Finding {
  file: string;
  line: number;
  text: string;
  kind: 'jsx-text' | 'attribute' | 'rendered' | 'string' | 'template' | 'module-t';
}

type Node = { type: string; loc?: { start: { line: number } }; [key: string]: unknown };
type Frame = { node: Node; key: string };

/** Attributes whose value a person reads or hears. */
const SPOKEN_ATTRS = new Set([
  'aria-label', 'aria-valuetext', 'aria-description', 'aria-roledescription', 'aria-placeholder', 'title', 'alt',
  'placeholder', 'label', 'unit', 'suffix', 'prefix', 'subtitle', 'caption', 'note', 'detail', 'hint', 'legend',
  'heading', 'description', 'text', 'empty', 'emptyText', 'sub', 'eyebrow', 'tooltip',
]);

/** Attributes that never hold text, whatever their value looks like. */
const SILENT_ATTRS = new Set([
  'className', 'class', 'key', 'id', 'href', 'src', 'role', 'type', 'name', 'htmlFor', 'd', 'fill', 'stroke',
  'viewBox', 'points', 'transform', 'style', 'tone', 'cls', 'variant', 'size', 'align', 'target', 'rel', 'as',
  'autoComplete', 'inputMode', 'pattern', 'dir', 'lang', 'xmlns', 'strokeLinecap', 'strokeLinejoin', 'fillRule',
  'clipRule', 'gradientUnits', 'gradientTransform', 'offset', 'stopColor', 'textAnchor', 'dominantBaseline',
  'preserveAspectRatio', 'mask', 'clipPath', 'filter', 'markerEnd', 'domain', 'dataKey', 'stackId', 'layout',
  'orientation', 'interval', 'goodWhen', 'side', 'mode', 'kind', 'shape', 'icon', 'color', 'accent', 'span',
  'bucket', 'page', 'tab', 'state', 'status', 'position', 'curve', 'method', 'encType', 'scope', 'axis',
  'yAxisId', 'xAxisId', 'aria-live', 'aria-current', 'aria-hidden', 'aria-pressed', 'aria-expanded',
  'aria-controls', 'aria-describedby', 'aria-labelledby', 'aria-orientation', 'aria-haspopup', 'aria-checked',
  'aria-selected', 'aria-disabled', 'aria-invalid', 'aria-busy', 'aria-modal', 'aria-atomic', 'aria-relevant',
  'aria-sort', 'aria-autocomplete', 'tabIndex', 'dateTime', 'loading', 'decoding', 'crossOrigin', 'referrerPolicy',
  'enterKeyHint', 'capture', 'accept', 'form', 'formAction', 'wrap', 'spellCheck', 'translate',
]);

/** Calls whose string arguments are for developers or the platform, not for people. */
const SILENT_CALLS = new Set([
  'require', 'DOMException', 'clsx', 'cn', 'twMerge', 'addEventListener',
  'removeEventListener', 'querySelector', 'querySelectorAll', 'getElementById', 'setAttribute', 'getAttribute',
  'removeAttribute', 'hasAttribute', 'matchMedia', 'useMediaQuery', 'createElement', 'getItem', 'setItem', 'removeItem', 'fetch',
  'api', 'parse', 'stringify', 'RegExp', 'split', 'join', 'replace', 'replaceAll', 'startsWith', 'endsWith',
  'includes', 'indexOf', 'lastIndexOf', 'padStart', 'padEnd', 'match', 'matchAll', 'test', 'exec', 'localeCompare',
  'get', 'has', 'set', 'delete', 'append', 'postMessage', 'dispatchEvent', 'Event', 'CustomEvent', 'useState',
  'useRef', 'createContext', 'Symbol', 'Date', 'Intl', 'DateTimeFormat', 'NumberFormat', 'assert', 'log', 'warn',
  'error', 'info', 'debug', 'trace', 'group', 'groupEnd', 'time', 'timeEnd', 't', 'rich', 'tKey', 'names',
  'hasMessage', 'replaceState', 'pushState', 'open', 'getComputedStyle', 'getPropertyValue', 'setProperty',
  'measureText', 'scrollTo', 'animate',
]);

/**
 * Calls that translate: they must run inside a function, at render or when a sentence is built.
 * Anything imported from src/i18n counts too, and so do these helpers built on it.
 */
const TRANSLATE_CALLS = new Set(['t', 'rich', 'names', 'fmtNum', 'fmtDuration', 'spanLabel', 'spanSummaryTitle']);

/** Bare Tailwind utilities that are also English words. */
const TAILWIND_WORDS = new Set([
  'flex', 'grid', 'block', 'inline', 'hidden', 'relative', 'absolute', 'fixed', 'sticky', 'static', 'grow',
  'shrink', 'truncate', 'italic', 'uppercase', 'lowercase', 'capitalize', 'underline', 'contents', 'table',
  'isolate', 'invisible', 'visible', 'antialiased', 'rounded', 'border', 'shadow', 'outline', 'ring', 'transition',
  'transform', 'filter', 'blur', 'group', 'peer', 'container', 'prose', 'tabular', 'nums', 'ordinal', 'collapse',
  'grayscale', 'invert', 'sepia', 'resize', 'snap', 'touch', 'select', 'none', 'auto', 'full', 'screen', 'start',
  'end', 'center', 'between', 'around', 'evenly', 'stretch', 'baseline', 'wrap', 'nowrap', 'medium', 'semibold',
  'bold', 'normal', 'light', 'thin', 'black', 'white', 'transparent', 'current', 'inherit', 'solid', 'dashed',
  'dotted', 'double', 'pointer', 'default', 'move', 'text', 'cursor', 'overflow', 'clip', 'scroll',
]);

/** Words that are CSS or code, not English. */
const CODE_WORDS = new Set([
  'px', 'rem', 'em', 'deg', 'vh', 'vw', 'fr', 'translate', 'translateX', 'translateY', 'rotate', 'scale', 'url',
  'rgba', 'rgb', 'hsl', 'hsla', 'calc', 'var', 'min', 'max', 'clamp', 'repeat', 'minmax', 'auto', 'none', 'solid',
  'dashed', 'transparent', 'inherit', 'ease', 'linear', 'infinite', 'forwards', 'cubic', 'bezier', 'matrix',
  'inset', 'bold', 'normal', 'italic', 'serif', 'sans', 'monospace', 'system', 'ui', 'nowrap', 'pointer',
]);

const LETTER = /\p{L}/u;
const WORD = /^\p{L}[\p{L}\p{M}'’]*(?:-\p{L}[\p{L}\p{M}'’]*)*$/u;
const trim = (w: string) => w.replace(/^[("'“‘«¿¡[]+|[)"'”’».,;:!?…\]]+$/gu, '');
const words = (s: string) =>
  s.split(/\s+/).map(trim).filter((w) => WORD.test(w) && (w.length > 1 || w === 'a' || w === 'I'));

/** A Tailwind class list: every token a bare utility, or one with a variant, a dash or a number. */
function classList(s: string): boolean {
  const toks = s.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  const utility = (t: string) =>
    /^!?-?[a-z0-9@][a-z0-9:/.\[\]#%_()&>,=*+'-]*$/.test(t) && /[-:\[/]|\d/.test(t) && !/[:,.]$/.test(t);
  return toks.every((t) => TAILWIND_WORDS.has(t) || utility(t));
}

/** URLs, paths, CSS, dates and other strings for machines. */
function machine(s: string): boolean {
  const x = s.trim();
  if (/^(https?:|mailto:|data:|\/|\.\.?\/|#[0-9a-f]{3,8}\b)/i.test(x)) return true;
  if (/^[\w$.-]+\/[\w$./-]*$/.test(x)) return true; // a/b paths, MIME types, IANA zones
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(x)) return true; // camelCase identifier
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(x)) return true; // PascalCase identifier
  if (/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(x)) return true; // kebab, snake or dotted id
  if (/^[A-Z0-9_]+$/.test(x)) return true; // CONSTANT
  return false;
}

/** Text a person would read, judged on its own, outside any rendering context. */
function readsAsText(s: string): boolean {
  if (!LETTER.test(s) || classList(s) || machine(s)) return false;
  const ws = words(s).filter((w) => !CODE_WORDS.has(w));
  if (ws.length >= 2 && /\s/.test(s.trim())) return true;
  return ws.some((w) => /^\p{Lu}\p{Ll}/u.test(w));
}

/** Anything with letters that isn't a class list, CSS or an identifier: for places that are certainly shown. */
function shownText(s: string): boolean {
  if (!LETTER.test(s) || classList(s)) return false;
  const x = s.trim();
  if (/^(https?:|mailto:|data:|\/|\.\.?\/)/.test(x)) return false;
  return true;
}

function nodeText(n: Node): string | null {
  if (n.type === 'StringLiteral') return n.value as string;
  if (n.type === 'TemplateLiteral') {
    const quasis = n.quasis as { value: { cooked: string } }[];
    return quasis.map((q) => q.value.cooked).join(' § ');
  }
  return null;
}

const calleeName = (callee: Node): string | null => {
  if (callee.type === 'Identifier') return callee.name as string;
  if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
    const p = callee.property as Node;
    if (p.type === 'Identifier') return p.name as string;
  }
  return null;
};

const attrName = (attr: Node): string => {
  const n = attr.name as Node;
  if (n.type === 'JSXIdentifier') return n.name as string;
  if (n.type === 'JSXNamespacedName') return `${(n.namespace as Node).name}:${(n.name as Node).name}`;
  return '';
};

const TRANSPARENT = new Set([
  'ConditionalExpression', 'LogicalExpression', 'TemplateLiteral', 'TSAsExpression', 'TSSatisfiesExpression',
  'TSNonNullExpression', 'ParenthesizedExpression', 'ArrayExpression', 'SequenceExpression',
]);

/** Where a literal's value ends up: rendered as a JSX child, inside an attribute, or neither. */
function destination(stack: Frame[]): { kind: 'child' } | { kind: 'attr'; name: string } | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const { node, key } = stack[i];
    const parent = stack[i - 1]?.node;
    if (!parent) return null;
    if (parent.type === 'JSXExpressionContainer') {
      const holder = stack[i - 2]?.node;
      if (!holder) return null;
      if (holder.type === 'JSXElement' || holder.type === 'JSXFragment') return { kind: 'child' };
      if (holder.type === 'JSXAttribute') return { kind: 'attr', name: attrName(holder) };
      return null;
    }
    if (parent.type === 'ConditionalExpression' && key === 'test') return null;
    if (parent.type === 'BinaryExpression') {
      if (parent.operator !== '+') return null;
      continue;
    }
    if (parent.type === 'LogicalExpression') {
      if (key === 'left' && parent.operator === '&&') return null;
      continue;
    }
    if (parent.type === 'TemplateLiteral' && key !== 'expressions') return null;
    if (!TRANSPARENT.has(parent.type)) return null;
    void node;
  }
  return null;
}

/** Contexts where a string is a key, an id or a comparison, whatever it says. */
function silentContext(stack: Frame[]): boolean {
  const { key } = stack[stack.length - 1];
  const parent = stack[stack.length - 2]?.node;
  if (!parent) return false;
  switch (parent.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'ImportExpression':
    case 'TSLiteralType':
    case 'TSImportType':
    case 'TSExternalModuleReference':
    case 'TSEnumMember':
    case 'TSPropertySignature':
    case 'Directive':
      return true;
    case 'ObjectProperty':
    case 'ObjectMethod':
    case 'ClassProperty':
    case 'ClassMethod':
      return key === 'key';
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return key === 'property';
    case 'BinaryExpression':
      return ['===', '!==', '==', '!=', 'in', 'instanceof'].includes(parent.operator as string);
    case 'SwitchCase':
      return key === 'test';
    case 'JSXAttribute':
      return SILENT_ATTRS.has(attrName(parent)) || attrName(parent).startsWith('data-');
  }
  // Arguments of developer-facing calls, wherever they sit in the argument.
  for (let i = stack.length - 2; i >= 0; i--) {
    const n = stack[i].node;
    if ((n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'OptionalCallExpression') && stack[i + 1]?.key === 'arguments') {
      const name = calleeName(n.callee as Node);
      if (name && SILENT_CALLS.has(name)) return true;
      const callee = n.callee as Node;
      if (callee.type === 'MemberExpression' && (callee.object as Node).type === 'Identifier' && (callee.object as Node).name === 'console') return true;
      return false;
    }
    if (n.type.endsWith('Function') || n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression' || n.type === 'JSXElement') break;
  }
  return false;
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'range']);

export function scanSource(file: string, source: string): Finding[] {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    errorRecovery: false,
  }) as unknown as Node;
  const lines = source.split('\n');
  const ignored = (line: number) => /i18n-ignore/.test(lines[line - 1] ?? '') || /i18n-ignore/.test(lines[line - 2] ?? '');
  const out: Finding[] = [];
  const add = (n: Node, kind: Finding['kind'], text: string) => {
    const line = n.loc?.start.line ?? 0;
    if (!ignored(line)) out.push({ file, line, text: text.replace(/\s+/g, ' ').trim(), kind });
  };

  // Names this file imports from src/i18n: calling one translates, apart from choosing the language.
  const fromI18n = new Set<string>();
  for (const st of ((ast as Node).program as Node).body as Node[]) {
    if (st.type !== 'ImportDeclaration' || !/(^|\/)i18n(\/|$)/.test((st.source as Node).value as string)) continue;
    for (const sp of st.specifiers as Node[]) {
      const name = (sp.local as Node).name as string;
      if (name !== 'setLocale' && name !== 'pickLocale') fromI18n.add(name);
    }
  }

  const insideFunction = (stack: Frame[]) =>
    stack.some(({ node }) => /Function|ArrowFunctionExpression|ClassMethod|ObjectMethod/.test(node.type));

  const visit = (node: Node, stack: Frame[]) => {
    switch (node.type) {
      case 'JSXText': {
        const text = node.value as string;
        if (LETTER.test(text)) add(node, 'jsx-text', text);
        return;
      }
      case 'CallExpression': {
        const name = calleeName(node.callee as Node);
        const translates = name && (TRANSLATE_CALLS.has(name) || fromI18n.has(name));
        if (translates && (node.callee as Node).type === 'Identifier' && !insideFunction(stack)) {
          add(node, 'module-t', name + '()');
        }
        break;
      }
      case 'StringLiteral':
      case 'TemplateLiteral': {
        // A template inside another template is judged as part of the outer one.
        const parent = stack[stack.length - 2]?.node;
        if (node.type === 'TemplateLiteral' && parent?.type === 'TaggedTemplateExpression') return;
        if (silentContext(stack)) break;
        const text = nodeText(node);
        if (text === null) break;
        const dest = destination(stack) ?? (parent?.type === 'JSXAttribute' ? { kind: 'attr' as const, name: attrName(parent) } : null);
        if (dest?.kind === 'child') {
          if (shownText(text.replaceAll('§', ''))) add(node, 'rendered', text);
        } else if (dest?.kind === 'attr') {
          if (SILENT_ATTRS.has(dest.name) || dest.name.startsWith('data-')) break;
          const spoken = SPOKEN_ATTRS.has(dest.name) || dest.name.startsWith('aria-');
          if (spoken ? shownText(text.replaceAll('§', '')) : readsAsText(text.replaceAll('§', ' '))) add(node, 'attribute', text);
        } else if (readsAsText(text.replaceAll('§', ' '))) {
          add(node, node.type === 'StringLiteral' ? 'string' : 'template', text);
        }
        if (node.type === 'StringLiteral') return;
        break;
      }
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && typeof (child as Node).type === 'string') {
            visit(child as Node, [...stack, { node: child as Node, key }]);
          }
        }
      } else if (value && typeof value === 'object' && typeof (value as Node).type === 'string') {
        visit(value as Node, [...stack, { node: value as Node, key }]);
      }
    }
  };
  const program = (ast as Node).program as Node;
  visit(program, [{ node: program, key: 'program' }]);
  return out;
}

/** Every .ts and .tsx file under `dir`, tests and declaration files left out. */
export function sourceFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(p);
      } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
        out.push(relative(root, p));
      }
    }
  };
  walk(join(root, dir));
  return out.sort();
}

export function scanFiles(root: string, files: string[]): Finding[] {
  return files.flatMap((f) => scanSource(f, readFileSync(join(root, f), 'utf8')));
}
