// The MCP surface: the tool table, and the server's protocol behaviour.
//
//   node --test test/mcp.test.mjs
//
// The server holds no credentials and makes no authorization decision, so the
// things worth testing are that it challenges rather than fails, that it never
// forwards without a token, and that every tool maps to a request the admin API
// would recognize.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TOOLS, TOOLS_BY_NAME, toolManifest, toRequest, toolText, PROTOCOL_VERSION,
} from "../shared/mcp.mjs";
import { requirementFor } from "../shared/scopes.mjs";

// The server reads its origins from the environment at import time.
process.env.QW_API_ORIGIN = "https://app.example.test";
process.env.OAUTH_ISSUER = "https://app.example.test";
process.env.MCP_ORIGIN = "https://mcp.example.test";
const { handle } = await import("../mcp/server.mjs");

const post = (message, token = "qwp_test") => handle({
  method: "POST",
  pathname: "/mcp",
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: Buffer.from(JSON.stringify(message)),
});
const parse = (res) => JSON.parse(res.body);

// -------------------------------------------------------------- the tool table
test("every tool has a name, a schema and an annotation", () => {
  assert.ok(TOOLS.length >= 15);
  const seen = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, t.name);
    assert.ok(!seen.has(t.name), `duplicate tool: ${t.name}`);
    seen.add(t.name);
    assert.ok(t.description?.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(!(t.readOnly && t.destructive), `${t.name} cannot be both`);
  }
});

test("the manifest marks read-only and destructive correctly", () => {
  const byName = new Map(toolManifest().map((t) => [t.name, t]));
  assert.equal(byName.get("whoami").annotations.readOnlyHint, true);
  assert.equal(byName.get("preview_changeset").annotations.readOnlyHint, true);

  // These change what a reader can already see, or throw work away.
  for (const n of ["publish", "delete_content", "adopt_template", "set_theme", "delete_static_page"]) {
    assert.equal(byName.get(n).annotations.destructiveHint, true, `${n} must be marked destructive`);
  }
  // These stage a change and nothing more.
  for (const n of ["create_content", "upload_template", "put_static_page"]) {
    assert.equal(byName.get(n).annotations.destructiveHint, false, `${n} only stages`);
  }
  // Nothing here reaches outside the Quickieweb API.
  for (const t of toolManifest()) assert.equal(t.annotations.openWorldHint, false);
});

test("publishing is separable from writing, and says so in its own description", () => {
  const publish = TOOLS_BY_NAME.get("publish");
  assert.ok(/preview_changeset/.test(publish.description),
    "the publish tool must point at the check that precedes it");
  assert.ok(/EVERYTHING staged|not only what you changed/i.test(publish.description),
    "an agent must be told a changeset can contain work it did not author");
});

// ------------------------------------------------------------------- mapping
test("every tool maps to a request the API would recognize", () => {
  const args = {
    site: "acme", slug: "a-post", id: "mytheme", path: "shop/tees.html",
    type: "article", title: "T", body: "<p>x</p>", files: { "template.json": "{}" },
    theme: { "color.accent": "#fff" },
  };
  for (const tool of TOOLS) {
    const req = tool.request(args);
    assert.match(req.method, /^(GET|POST|PUT|DELETE)$/, tool.name);
    assert.match(req.path, /^\/api\//, `${tool.name} must call the admin API`);

    // The scope model has to know about the route, or a token could never use
    // the tool -- requirementFor returning null means "no token reaches this".
    const head = req.path.split("/")[2];
    if (tool.name !== "whoami") {
      assert.ok(requirementFor(head, req.method),
        `${tool.name} calls /${head}, which has no scope requirement`);
    }
  }
});

test("path arguments are encoded, not interpolated raw", () => {
  const req = toRequest("get_content", { site: "acme", slug: "a b/../c" });
  // The property that matters is that a slug stays ONE path segment: with the
  // slashes percent-encoded it cannot climb out of /api/articles/, and the dots
  // left inside a segment are inert. keyFor() in shared/site.mjs refuses a key
  // containing ".." as the backstop behind this.
  assert.ok(req.path.startsWith("/api/articles/"), req.path);
  assert.equal(req.path.split("/").length, 4, `escaped its segment: ${req.path}`);
  assert.ok(req.path.includes("%2F"), `slashes must be encoded: ${req.path}`);
  assert.ok(!req.path.includes(" "), req.path);

  // A static page path keeps its slashes -- they are real structure -- but each
  // segment is still encoded.
  const stat = toRequest("get_static_page", { site: "acme", path: "shop/a b.html" });
  assert.ok(stat.path.endsWith("shop/a%20b.html"), stat.path);
});

test("a missing required argument is refused before any request is built", () => {
  assert.throws(() => toRequest("get_content", { site: "acme" }), /"slug" is required/);
  assert.throws(() => toRequest("list_content", {}), /"site" is required/);
  assert.throws(() => toRequest("no_such_tool", {}), /No such tool/);
});

test("routing fields do not leak into the request body", () => {
  const req = toRequest("create_content",
    { site: "acme", type: "article", title: "T", body: "<p>x</p>" });
  assert.equal(req.site, "acme");
  assert.ok(!("site" in req.body), "site travels as a header, not a field");
  assert.deepEqual(Object.keys(req.body).sort(), ["body", "title", "type"]);
});

// ------------------------------------------------------------------ protocol
test("no token gets a transport 401 with the discovery pointer", async () => {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
  assert.equal(res.status, 401, "a tool result saying 'auth failed' would make the client "
    + "report a broken tool instead of signing in");
  assert.match(res.headers["www-authenticate"], /^Bearer /);
  assert.match(res.headers["www-authenticate"],
    /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
});

test("a GET on /mcp also challenges, rather than 405ing", async () => {
  const res = await handle({ method: "GET", pathname: "/mcp", headers: {}, body: null });
  assert.equal(res.status, 401);
  assert.ok(res.headers["www-authenticate"]);
});

test("protected-resource metadata is served without a token", async () => {
  const res = await handle({
    method: "GET", pathname: "/.well-known/oauth-protected-resource", headers: {}, body: null,
  });
  assert.equal(res.status, 200);
  const doc = JSON.parse(res.body);
  assert.deepEqual(doc.authorization_servers, ["https://app.example.test"]);
  assert.equal(doc.resource, "https://mcp.example.test/mcp");
});

test("initialize answers with the protocol version and usable instructions", async () => {
  const out = parse(await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  assert.equal(out.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(out.result.serverInfo.name, "quickieweb");
  assert.match(out.result.instructions, /whoami/);
  assert.match(out.result.instructions, /preview_changeset/,
    "the standing instruction about publishing belongs where every client reads it");
});

test("tools/list needs no network and returns the manifest", async () => {
  const out = parse(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assert.equal(out.result.tools.length, TOOLS.length);
});

test("a notification produces no response body", async () => {
  const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(res.body, "");
});

test("an unknown method is a protocol error, not a crash", async () => {
  const out = parse(await post({ jsonrpc: "2.0", id: 3, method: "resources/list" }));
  assert.equal(out.error.code, -32601);
});

test("a malformed request is refused per message, not per batch", async () => {
  const out = parse(await post([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { not: "a request" },
  ]));
  assert.equal(out.length, 2);
  assert.ok(out[0].result, "the good one still answers");
  assert.equal(out[1].error.code, -32600);
});

test("a bad tool argument comes back as a tool error the model can read", async () => {
  const out = parse(await post({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "get_content", arguments: { site: "acme" } },
  }));
  assert.ok(!out.error, "a protocol error would tell the model the transport broke");
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /"slug" is required/);
});

test("tool results carry text content", () => {
  assert.deepEqual(toolText("hi"), { content: [{ type: "text", text: "hi" }] });
  assert.equal(toolText({ a: 1 }).content[0].text, '{\n  "a": 1\n}');
  assert.equal(toolText("no", true).isError, true);
});
