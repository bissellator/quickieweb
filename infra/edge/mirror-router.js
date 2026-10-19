// CloudFront Function, viewer request, for a custom-domain MIRROR of one site
// (infra/wire-mirror.mjs). The distribution's origin path is already that
// site's prefix, so there is no Host routing and no access check here: a mirror
// serves one public site. All this does is what S3's REST endpoint will not --
// "/" and "/dir/" mean index.html.
//
// A site that needs redirects (old URLs) passes its own function to
// wire-mirror.mjs instead; keep this behaviour in it.
//
// Runtime: cloudfront-js-2.0.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.length === 0 || uri.charAt(uri.length - 1) === '/') request.uri = uri + 'index.html';
  return request;
}
