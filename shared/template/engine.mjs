// The template engine.
//
// Templates are DATA, not code. An uploaded template is rendered by walking an
// AST built from a fixed grammar -- there is no `eval`, no `new Function`, no
// property call, and no way for a template to reach the filesystem, the network
// or the Lambda's environment. That property is why an untrusted template from
// the library can be rendered in the same process as everything else, and it is
// not negotiable: any future "just let templates run a little JS" turns this
// into remote code execution for every tenant at once.
//
// The grammar is a Handlebars subset, chosen because LLMs already write it
// correctly without being taught:
//
//   {{ path }}                 escaped interpolation
//   {{{ path }}}               raw interpolation (pre-sanitized HTML only)
//   {{#if path}} … {{else}} … {{/if}}
//   {{#unless path}} … {{/unless}}
//   {{#each path}} … {{else}} … {{/each}}
//   {{> partial}}
//   {{! comment }}
//
// Deliberately absent: expressions, helpers with arguments, subexpressions,
// filters, partial parameters, `{{^…}}`. Every one of them is a small step
// toward a language, and a language in a template is an execution surface.
//
// Inside {{#each}} the loop metadata is {{@index}} (0-based), {{@number}}
// (1-based), {{@first}}, {{@last}}, and {{.}} is the current item.

import { esc } from "../html.mjs";

export class TemplateError extends Error {
  constructor(message, { template, line } = {}) {
    super(template ? `${template}:${line ?? "?"}: ${message}` : message);
    this.name = "TemplateError";
    this.template = template;
    this.line = line;
  }
}

const BLOCK_HELPERS = new Set(["if", "unless", "each"]);
// A partial that includes itself would otherwise recurse until the stack dies,
// which in a Lambda is a 500 with no useful message.
const MAX_PARTIAL_DEPTH = 32;

// --------------------------------------------------------------- tokenize
// The triple-brace alternative is first so `{{{x}}}` is never read as a double
// brace wrapping a `{`.
const TAG_RE = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]*?)\s*\}\}/g;

function tokenize(src, template) {
  const out = [];
  const re = new RegExp(TAG_RE.source, "g");
  let last = 0;
  let line = 1;
  let m;

  const advance = (text) => {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") line++;
  };

  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      const text = src.slice(last, m.index);
      out.push({ t: "text", v: text });
      advance(text);
    }
    out.push({ t: "tag", raw: m[1] !== undefined, body: (m[1] ?? m[2]).trim(), line });
    advance(m[0]);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

// ------------------------------------------------------------------ parse
function parse(tokens, template) {
  let i = 0;

  function block(closer, openLine) {
    const nodes = [];
    let inverse = null;
    let current = nodes;

    while (i < tokens.length) {
      const tk = tokens[i];

      if (tk.t === "text") {
        current.push({ t: "text", v: tk.v });
        i++;
        continue;
      }

      const b = tk.body;
      const at = { template, line: tk.line };

      if (b.startsWith("!")) { i++; continue; }

      if (b.startsWith("/")) {
        const name = b.slice(1).trim();
        if (!closer) throw new TemplateError(`Unexpected {{/${name}}} with no open block.`, at);
        if (name !== closer) {
          throw new TemplateError(`Expected {{/${closer}}} but found {{/${name}}}.`, at);
        }
        i++;
        return { nodes, inverse };
      }

      if (b === "else") {
        if (!closer) throw new TemplateError("{{else}} outside a block.", at);
        if (inverse) throw new TemplateError(`Second {{else}} in one {{#${closer}}}.`, at);
        inverse = [];
        current = inverse;
        i++;
        continue;
      }

      if (b.startsWith(">")) {
        const name = b.slice(1).trim();
        if (!name) throw new TemplateError("{{> }} needs a partial name.", at);
        current.push({ t: "partial", name, line: tk.line });
        i++;
        continue;
      }

      if (b.startsWith("^")) {
        throw new TemplateError("{{^…}} is not supported. Use {{#unless …}}.", at);
      }

      if (b.startsWith("#")) {
        const rest = b.slice(1).trim();
        const sp = rest.search(/\s/);
        const kind = sp === -1 ? rest : rest.slice(0, sp);
        const path = sp === -1 ? "" : rest.slice(sp + 1).trim();

        if (!BLOCK_HELPERS.has(kind)) {
          throw new TemplateError(
            `Unknown block helper {{#${kind}}}. Only #if, #unless and #each exist.`, at);
        }
        if (!path) throw new TemplateError(`{{#${kind}}} needs a path.`, at);
        if (/\s/.test(path)) {
          throw new TemplateError(
            `{{#${kind} ${path}}} takes one path and no arguments.`, at);
        }

        const line = tk.line;
        i++;
        const inner = block(kind, line);
        current.push({ t: "block", kind, path, body: inner.nodes, inverse: inner.inverse, line });
        continue;
      }

      if (!b) throw new TemplateError("Empty {{}}.", at);
      current.push({ t: "var", path: b, raw: tk.raw, line: tk.line });
      i++;
    }

    if (closer) {
      throw new TemplateError(`Unclosed {{#${closer}}}.`, { template, line: openLine });
    }
    return { nodes, inverse };
  }

  return block(null, 1).nodes;
}

/** Source -> AST. Throws TemplateError with a line number on any syntax problem. */
export function compile(source, template = "template") {
  return parse(tokenize(String(source), template), template);
}

// ----------------------------------------------------------------- render
//
// Paths are dotted and resolve against a context stack, innermost first, so a
// template can reach `site.name` from inside `{{#each posts}}`. A path that
// resolves nowhere renders as empty rather than throwing: at render time a
// missing field should not take a whole site down. Catching the typo is the
// validator's job, statically, before the template is ever published.
function lookup(stack, path) {
  if (path === ".") return stack[stack.length - 1].value;

  if (path.startsWith("@")) {
    const key = path.slice(1);
    for (let i = stack.length - 1; i >= 0; i--) {
      const meta = stack[i].meta;
      if (meta && Object.hasOwn(meta, key)) return meta[key];
    }
    return undefined;
  }

  const parts = path.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    let cur = stack[i].value;
    let ok = true;
    for (const p of parts) {
      if (cur !== null && typeof cur === "object" && Object.hasOwn(cur, p)) cur = cur[p];
      else { ok = false; break; }
    }
    if (ok) return cur;
  }
  return undefined;
}

const isTruthy = (v) => {
  if (v === undefined || v === null || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

function exec(nodes, stack, ctx, depth) {
  let out = "";

  for (const n of nodes) {
    if (n.t === "text") { out += n.v; continue; }

    if (n.t === "var") {
      const v = lookup(stack, n.path);
      if (v === undefined || v === null || v === false) continue;
      out += n.raw ? String(v) : esc(String(v));
      continue;
    }

    if (n.t === "partial") {
      const p = ctx.partials[n.name];
      if (!p) {
        throw new TemplateError(
          `No partial named "${n.name}". Declare it in template.json under "partials".`,
          { template: ctx.template, line: n.line });
      }
      if (depth >= MAX_PARTIAL_DEPTH) {
        throw new TemplateError(
          `Partial nesting deeper than ${MAX_PARTIAL_DEPTH} -- "${n.name}" probably includes itself.`,
          { template: ctx.template, line: n.line });
      }
      out += exec(p, stack, ctx, depth + 1);
      continue;
    }

    const v = lookup(stack, n.path);

    if (n.kind === "each") {
      const arr = Array.isArray(v) ? v : [];
      if (arr.length === 0) {
        if (n.inverse) out += exec(n.inverse, stack, ctx, depth);
        continue;
      }
      for (let idx = 0; idx < arr.length; idx++) {
        stack.push({
          value: arr[idx],
          meta: { index: idx, number: idx + 1, first: idx === 0, last: idx === arr.length - 1 },
        });
        out += exec(n.body, stack, ctx, depth);
        stack.pop();
      }
      continue;
    }

    const pass = n.kind === "if" ? isTruthy(v) : !isTruthy(v);
    if (pass) out += exec(n.body, stack, ctx, depth);
    else if (n.inverse) out += exec(n.inverse, stack, ctx, depth);
  }

  return out;
}

/**
 * Render a compiled AST.
 *
 * @param nodes     AST from compile()
 * @param data      the view model (see shared/template/viewmodel.mjs)
 * @param partials  { name: AST }, already compiled
 */
export function render(nodes, data, { partials = {}, template = "template" } = {}) {
  return exec(nodes, [{ value: data, meta: null }], { partials, template }, 0);
}

/**
 * Every path a template reads, with the line it was read on. The validator
 * checks these against the documented view model, which is what turns a
 * hallucinated field name into an error at upload time instead of a blank spot
 * on a published page.
 *
 * Paths inside {{#each}} are reported relative to the iterated path, joined with
 * "[]" -- `posts[].headline` -- so the checker knows which shape to look in.
 */
export function usedPaths(nodes, prefix = "") {
  const out = [];
  const walk = (list, scope) => {
    for (const n of list) {
      if (n.t === "var") {
        if (n.path !== "." && !n.path.startsWith("@")) out.push({ path: n.path, scope, line: n.line });
      } else if (n.t === "block") {
        // `{{#if @first}}` reads loop metadata, not the view model.
        if (n.path !== "." && !n.path.startsWith("@")) out.push({ path: n.path, scope, line: n.line });
        const inner = n.kind === "each" ? (scope ? `${scope}.${n.path}[]` : `${n.path}[]`) : scope;
        walk(n.body, inner);
        if (n.inverse) walk(n.inverse, scope);
      }
    }
  };
  walk(nodes, prefix);
  return out;
}

/** Every partial a template includes, with its line. */
export function usedPartials(nodes) {
  const out = [];
  const walk = (list) => {
    for (const n of list) {
      if (n.t === "partial") out.push({ name: n.name, line: n.line });
      else if (n.t === "block") { walk(n.body); if (n.inverse) walk(n.inverse); }
    }
  };
  walk(nodes);
  return out;
}
