// The MCP surface: what an assistant can do, expressed as data.
//
// Pure: no filesystem, no S3, no network, no SDK.
//
// Every tool is a row in TOOLS below -- a name, a schema, an annotation, and
// the API request it becomes. There is no per-tool code, so adding one is a
// row rather than a handler, and the server cannot accumulate logic that
// disagrees with the API it fronts.
//
// That is the same discipline templates follow here, for the same reason: the
// thing in the middle should describe, not decide. Every authorization question
// is answered by the admin API using the caller's own token, so a tool cannot
// do something a person with that token could not.
//
// ANNOTATIONS ARE PART OF THE CONTRACT
//
// readOnlyHint and destructiveHint are what let a well-behaved client prompt
// before the ones that matter instead of guessing. "Destructive" here means it
// changes something a reader can already see, or throws work away -- not merely
// that it writes.

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "quickieweb", version: "1.0.0" };

const str = (description, extra = {}) => ({ type: "string", description, ...extra });

/** Shorthand: most tools take a site, because almost everything is per-site. */
const withSite = (props = {}, required = []) => ({
  type: "object",
  properties: {
    site: str("The site id, e.g. \"crunchyts\". Use whoami to list the ones you can reach."),
    ...props,
  },
  required: ["site", ...required],
});

export const TOOLS = [
  {
    name: "whoami",
    title: "Who am I",
    description:
      "Identity, every site you can reach and your role on each, and what this token "
      + "actually allows. Run this first: a step you lack the role for is better learnt "
      + "now than three tools later.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    request: () => ({ method: "GET", path: "/api/sites" }),
  },

  // ------------------------------------------------------------------ content
  {
    name: "list_content",
    title: "List posts and pages",
    description: "Every post, gallery and page on a site, with slug, type and status.",
    readOnly: true,
    inputSchema: withSite(),
    request: (a) => ({ method: "GET", path: "/api/articles", site: a.site }),
  },
  {
    name: "get_content",
    title: "Read one post or page",
    description: "One record in full, body included.",
    readOnly: true,
    inputSchema: withSite({ slug: str("The record's slug.") }, ["slug"]),
    request: (a) => ({ method: "GET", path: `/api/articles/${enc(a.slug)}`, site: a.site }),
  },
  {
    name: "create_content",
    title: "Create a post or page",
    description:
      "Write a new record. Stages a rebuild; nothing reaches readers until publish. "
      + "type is article, podcast, gallery or page. For a gallery, put the images in "
      + "the body as <img> tags -- they are split out into a grid on save.",
    inputSchema: withSite({
      type: str("article, podcast, gallery or page.", { enum: ["article", "podcast", "gallery", "page"] }),
      title: str("The headline."),
      dek: str("A one-line standfirst. Required to publish."),
      body: str("HTML. Paragraphs, headings, lists, images, code blocks."),
      date: str("YYYY-MM-DD. Dated types only; defaults to today."),
      status: str("draft or published.", { enum: ["draft", "published"] }),
    }, ["type", "title"]),
    request: (a) => ({ method: "POST", path: "/api/articles", site: a.site, body: withoutSite(a) }),
  },
  {
    name: "update_content",
    title: "Update a post or page",
    description:
      "Change an existing record. Only the fields you send are changed; the slug is "
      + "the identity and cannot be changed here.",
    inputSchema: withSite({
      slug: str("The record to change."),
      title: str("New headline."),
      dek: str("New standfirst."),
      body: str("New HTML body. Replaces the old one entirely."),
      status: str("draft or published.", { enum: ["draft", "published"] }),
    }, ["slug"]),
    request: (a) => ({
      method: "PUT", path: `/api/articles/${enc(a.slug)}`, site: a.site,
      body: withoutSite(a, ["slug"]),
    }),
  },
  {
    name: "delete_content",
    title: "Delete a post or page",
    description: "Remove a record and its rendered page. The live site keeps it until the next publish.",
    destructive: true,
    inputSchema: withSite({ slug: str("The record to delete.") }, ["slug"]),
    request: (a) => ({ method: "DELETE", path: `/api/articles/${enc(a.slug)}`, site: a.site }),
  },

  // ---------------------------------------------------------------- templates
  {
    name: "list_templates",
    title: "List templates",
    description:
      "Both shelves: the shared library, and templates this site uploaded for itself. "
      + "The one in use is marked.",
    readOnly: true,
    inputSchema: withSite(),
    request: (a) => ({ method: "GET", path: "/api/templates", site: a.site }),
  },
  {
    name: "validate_template",
    title: "Check a template without uploading it",
    description:
      "A dry run. Returns findings with a file and a line for anything wrong, and writes "
      + "nothing. Use this after every draft and after every fix: it is how you check your "
      + "own work against a contract rather than guessing at it.",
    readOnly: true,
    inputSchema: withSite({
      files: {
        type: "object",
        description:
          "The package as a map of path to text: template.json, layouts/*.html, "
          + "partials/*.html, assets/style.css.",
        additionalProperties: { type: "string" },
      },
    }, ["files"]),
    request: (a) => ({
      method: "POST", path: "/api/templates/validate", site: a.site, body: { files: a.files },
    }),
  },
  {
    name: "upload_template",
    title: "Upload a template to this site",
    description:
      "Store a package as a new version of this site's own template. Validated first; a "
      + "package that fails is refused with the findings and nothing is written. Uploading "
      + "does not switch the site to it.",
    inputSchema: withSite({
      files: {
        type: "object",
        description: "The package as a map of path to text.",
        additionalProperties: { type: "string" },
      },
    }, ["files"]),
    request: (a) => ({ method: "POST", path: "/api/templates", site: a.site, body: { files: a.files } }),
  },
  {
    name: "adopt_template",
    title: "Switch the site to a template",
    description:
      "Change which template renders the site. Every post and page is kept, but every page "
      + "is re-rendered. Look at a preview first.",
    destructive: true,
    inputSchema: withSite({
      id: str("The template id."),
      scope: str("library for the shared one, site for your own.", { enum: ["library", "site"] }),
    }, ["id"]),
    request: (a) => ({
      method: "PUT", path: "/api/templates", site: a.site,
      body: { id: a.id, scope: a.scope ?? "site" },
    }),
  },
  {
    name: "delete_template",
    title: "Delete one of this site's templates",
    description: "Remove a private template and every version of it. Refused while it is in use.",
    destructive: true,
    inputSchema: withSite({ id: str("The template id.") }, ["id"]),
    request: (a) => ({ method: "DELETE", path: `/api/templates/${enc(a.id)}`, site: a.site }),
  },

  // ------------------------------------------------------------ static pages
  {
    name: "list_static_pages",
    title: "List hand-authored pages",
    description: "Complete documents published verbatim, outside the content model.",
    readOnly: true,
    inputSchema: withSite(),
    request: (a) => ({ method: "GET", path: "/api/static", site: a.site }),
  },
  {
    name: "get_static_page",
    title: "Read a hand-authored page",
    readOnly: true,
    description: "The document's source, exactly as stored.",
    inputSchema: withSite({ path: str("e.g. shop/tees.html") }, ["path"]),
    request: (a) => ({ method: "GET", path: `/api/static/${encPath(a.path)}`, site: a.site }),
  },
  {
    name: "put_static_page",
    title: "Upload a hand-authored page",
    description:
      "A complete HTML document, published exactly as written -- your own markup, styles "
      + "and scripts, with none of the site's furniture around it. For a page the editor "
      + "cannot express. It is not searchable and gets no nav slot. Also takes the "
      + "stylesheets and scripts such a page loads. At a path the template also writes "
      + "(index.html, assets/style.css) it replaces the template's file.",
    inputSchema: withSite({
      path: str("Where it lands, e.g. shop/tees.html"),
      body: str("The whole document."),
    }, ["path", "body"]),
    request: (a) => ({
      method: "PUT", path: `/api/static/${encPath(a.path)}`, site: a.site, body: { body: a.body },
    }),
  },
  {
    name: "delete_static_page",
    title: "Delete a hand-authored page",
    destructive: true,
    description: "Remove it. The live site keeps it until the next publish.",
    inputSchema: withSite({ path: str("The page to remove.") }, ["path"]),
    request: (a) => ({ method: "DELETE", path: `/api/static/${encPath(a.path)}`, site: a.site }),
  },

  // -------------------------------------------------------------------- theme
  {
    name: "get_theme",
    title: "Read colours and fonts",
    readOnly: true,
    description: "The settings the active template offers, and their current values.",
    inputSchema: withSite(),
    request: (a) => ({ method: "GET", path: "/api/theme", site: a.site }),
  },
  {
    name: "set_theme",
    title: "Change colours and fonts",
    destructive: true,
    description:
      "Overwrite design token values. Re-renders every page. Values the active template "
      + "does not declare are dropped rather than stored invisibly.",
    inputSchema: withSite({
      theme: {
        type: "object",
        description: "Token keys to values, e.g. {\"color.accent\": \"#b3341f\"}.",
        additionalProperties: { type: "string" },
      },
    }, ["theme"]),
    request: (a) => ({ method: "PUT", path: "/api/theme", site: a.site, body: { theme: a.theme } }),
  },

  // ------------------------------------------------------------------ publish
  {
    name: "preview_link",
    title: "Get a preview link",
    description:
      "A short-lived authenticated URL showing staged work, drafts included. This is what "
      + "you give a person to look at before anything goes live.",
    inputSchema: withSite({
      templateId: str("Optional: preview a template the site has not adopted."),
      templateScope: str("library or site.", { enum: ["library", "site"] }),
    }),
    request: (a) => ({
      method: "POST", path: "/api/preview", site: a.site,
      body: { siteId: a.site, templateId: a.templateId, templateScope: a.templateScope },
    }),
  },
  {
    name: "preview_changeset",
    title: "See exactly what publishing would do",
    readOnly: true,
    description:
      "The files a publish would copy and delete. Run this before every publish and show "
      + "the list: a changeset is a diff of the whole staging bucket, so it can contain "
      + "somebody else's unfinished work as well as yours.",
    inputSchema: withSite(),
    request: (a) => ({ method: "GET", path: "/api/publish", site: a.site }),
  },
  {
    name: "publish",
    title: "Publish to the live site",
    destructive: true,
    description:
      "Promote everything staged to the live site and clear the CDN. This affects readers "
      + "immediately. It publishes EVERYTHING staged, not only what you changed -- run "
      + "preview_changeset first and check nothing unexpected is in the list.",
    inputSchema: withSite(),
    request: (a) => ({ method: "POST", path: "/api/publish", site: a.site, body: {} }),
  },
];

const enc = (s) => encodeURIComponent(String(s ?? ""));
const encPath = (s) => String(s ?? "").split("/").map(encodeURIComponent).join("/");

/** Everything except the routing fields, so a body carries only real content. */
function withoutSite(args, drop = []) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === "site" || drop.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools/list payload. Annotations are part of the contract, not decoration. */
export const toolManifest = () => TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: {
    title: t.title,
    readOnlyHint: Boolean(t.readOnly),
    destructiveHint: Boolean(t.destructive),
    // Nothing here reaches outside the Quickieweb API.
    openWorldHint: false,
  },
}));

// ------------------------------------------------------------------ JSON-RPC
export const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

export const rpcError = (id, code, message, data) => ({
  jsonrpc: "2.0", id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

/**
 * Turn a tool call into the API request it stands for.
 *
 * Throws for an unknown tool or a missing required argument -- caught by the
 * caller and returned as a tool error rather than a protocol error, because a
 * model that passed the wrong argument should get a message it can act on
 * rather than a transport failure.
 */
export function toRequest(name, args = {}) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`No such tool: ${name}`);

  for (const required of tool.inputSchema.required ?? []) {
    if (args[required] === undefined || args[required] === "") {
      throw new Error(`"${required}" is required for ${name}`);
    }
  }
  return tool.request(args);
}

/** A tool result in MCP's shape. Errors are results, not transport failures. */
export const toolText = (text, isError = false) => ({
  content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }],
  ...(isError ? { isError: true } : {}),
});
