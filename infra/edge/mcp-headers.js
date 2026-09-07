// Restores WWW-Authenticate on the way out of the MCP distribution.
//
// A Lambda function URL RESERVES a handful of response headers and renames what
// the function sent to `x-amzn-Remapped-<name>`. WWW-Authenticate is one of
// them. So the 401 challenge that starts MCP's whole discovery flow arrives at
// the client as a header no client looks at, and authentication silently never
// begins -- the failure looks like "the server just returns 401 forever".
//
// This is the only reason this function exists. It renames the header back.
function handler(event) {
  var res = event.response;
  var h = res.headers;

  var remapped = h["x-amzn-remapped-www-authenticate"];
  if (remapped && !h["www-authenticate"]) {
    h["www-authenticate"] = remapped;
    delete h["x-amzn-remapped-www-authenticate"];
  }
  return res;
}
