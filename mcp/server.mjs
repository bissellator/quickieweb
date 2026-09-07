// The Quickieweb MCP server.
//
//   POST /mcp                                JSON-RPC: initialize, tools/list, tools/call
//   GET  /.well-known/oauth-protected-resource
//   GET  /health
//
// IT DECIDES NOTHING.
//
// No S3 client, no AWS SDK, no storage, no secret, no session. It attaches the
// caller's bearer to a request against the admin API, forwards it, and returns
// the answer. Every authorization decision is made there, by the same
// siteContext/roleInSite/scope checks a person's request goes through -- so a
// tool cannot do anything the holder of that token could not do by hand.
//
// The alternative is a second authorization model living here, which then has
// to be kept in step with the first one forever. The two drift, and the drift
// is invisible until an agent does something a person could not.
//
// It therefore needs no IAM permissions beyond writing its own logs, which is
// the whole reason it is a separate function rather than another route on the
// admin Lambda: this one holds nothing worth stealing.

import {
  PROTOCOL_VERSION, SERVER_INFO, toolManifest, toRequest, toolText,
  rpcResult, rpcError, RPC,
} from "../shared/mcp.mjs";

const API = (process.env.QW_API_ORIGIN ?? "").replace(/\/+$/, "");
const ISSUER = (process.env.OAUTH_ISSUER ?? "").replace(/\/+$/, "");
const SELF = (process.env.MCP_ORIGIN ?? "").replace(/\/+$/, "");

const json = (status, body, headers = {}) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  body: JSON.stringify(body),
});

/**
 * The challenge that starts discovery.
 *
 * A TRANSPORT-level 401, never a tool result that says "auth failed". The first
 * makes a client re-authenticate; the second makes it report a broken tool to
 * the person using it. resource_metadata is what points the client at the
 * authorization server it has never heard of.
 */
const challenge = (detail = "Authorization required") => json(401, {
  error: "unauthorized",
  error_description: detail,
}, {
  "www-authenticate":
    `Bearer realm="quickieweb", resource_metadata="${SELF}/.well-known/oauth-protected-resource"`,
});

const bearer = (headers) => {
  const raw = headers?.authorization ?? headers?.Authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : null;
};

/**
 * Forward one request to the admin API with the caller's own token.
 *
 * The site travels as X-QW-Site, exactly as the console sends it, so the API
 * resolves the tenant the same way for an agent as for a person.
 */
async function callApi(token, { method, path, site, body }) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(site ? { "x-qw-site": site } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed };
}

// --------------------------------------------------------------------- JSON-RPC
async function handleRpc(message, token) {
  const { id = null, method, params = {} } = message ?? {};

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "Quickieweb publishes static sites. Call whoami first: it reports which sites you "
        + "can reach and what this token allows.\n\n"
        + "Writing stages a change; nothing reaches readers until publish. Before any "
        + "publish, run preview_changeset and show the list -- it is a diff of the whole "
        + "staging area, so it can contain work you did not author.\n\n"
        + "When writing a template, use validate_template after every draft and after every "
        + "fix. It returns a file and a line for anything wrong and writes nothing.",
    });
  }

  // Notifications carry no id and take no response.
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return null;

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") return rpcResult(id, { tools: toolManifest() });

  if (method === "tools/call") {
    const name = params.name;
    let request;
    try {
      request = toRequest(name, params.arguments ?? {});
    } catch (err) {
      // A bad argument is something the model can fix, so it comes back as a
      // tool result it can read rather than a protocol error it cannot.
      return rpcResult(id, toolText(err.message, true));
    }

    const res = await callApi(token, request);
    if (res.ok) return rpcResult(id, toolText(res.body ?? { ok: true }));

    // An expired token has to reach the client as a transport 401, which is
    // handled by the caller -- this is every other failure.
    const detail = res.body?.error_description ?? res.body?.error ?? `HTTP ${res.status}`;
    const findings = res.body?.findings;
    return rpcResult(id, toolText(
      findings?.length
        ? `${detail}\n\n${findings.map((f) => `  ${f.file}:${f.line}  ${f.message}`).join("\n")}`
        : detail,
      true));
  }

  return rpcError(id, RPC.METHOD_NOT_FOUND, `Unknown method: ${method}`);
}

// ------------------------------------------------------------------- routing
export async function handle({ method, pathname, headers, body }) {
  if (pathname === "/health") {
    return json(200, { ok: true, server: SERVER_INFO, api: Boolean(API) });
  }

  // RFC 9728. Unauthenticated by definition: it is what a client reads in order
  // to find out how to authenticate.
  if (pathname === "/.well-known/oauth-protected-resource") {
    return json(200, {
      resource: `${SELF}/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["quickieweb"],
    });
  }

  if (pathname !== "/mcp") {
    return json(404, { error: "not_found" });
  }
  if (method === "GET" || method === "HEAD") {
    // Some clients probe with GET before posting. Answering with the challenge
    // rather than 405 starts discovery a round trip earlier.
    return challenge("This endpoint speaks MCP over POST.");
  }
  if (method !== "POST") return json(405, { error: "method_not_allowed" });

  const token = bearer(headers);
  if (!token) return challenge();

  let message;
  try {
    message = JSON.parse(body ? body.toString("utf8") : "{}");
  } catch {
    return json(400, rpcError(null, RPC.PARSE_ERROR, "Request body is not valid JSON"));
  }

  // A batch is an array. Notifications inside it produce nothing.
  const batch = Array.isArray(message) ? message : [message];
  const out = [];
  for (const m of batch) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      out.push(rpcError(m?.id ?? null, RPC.INVALID_REQUEST, "Not a JSON-RPC 2.0 request"));
      continue;
    }
    try {
      const r = await handleRpc(m, token);
      if (r) out.push(r);
    } catch (err) {
      // An expired or revoked token is a transport concern: answering it as a
      // failed tool would make the client report a broken tool instead of
      // signing in again.
      if (err?.status === 401) return challenge("Your access has expired. Sign in again.");
      console.error(err);
      out.push(rpcError(m.id ?? null, RPC.INTERNAL, err.message ?? "Internal error"));
    }
  }

  if (!out.length) return { status: 202, headers: { "cache-control": "no-store" }, body: "" };
  return json(200, Array.isArray(message) ? out : out[0]);
}

/** Lambda function URL entry point. */
export async function lambdaHandler(event) {
  const method = event?.requestContext?.http?.method ?? "GET";
  const pathname = (event?.rawPath ?? "/").replace(/\/+$/, "") || "/";
  const headers = Object.fromEntries(
    Object.entries(event?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = event?.body
    ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
    : null;

  try {
    const res = await handle({ method, pathname, headers, body });
    return { statusCode: res.status, headers: res.headers, body: res.body };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "internal_error" }),
    };
  }
}
