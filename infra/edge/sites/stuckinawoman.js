// CloudFront Function, viewer request, for www.stuckinawoman.com -- the
// custom-domain MIRROR of hosted site `stuckinawoman` (E1IVLQSMM1AGFH).
//
//   node infra/wire-mirror.mjs --site stuckinawoman --distribution E1IVLQSMM1AGFH \
//        --function infra/edge/sites/stuckinawoman.js
//
// infra/edge/mirror-router.js plus this site's old URLs. Before the move to
// quickieweb (2026-10-21) articles lived at /articles/<id>-<slug>.html; the
// platform renders every article at /<id>-<slug>.html, the same file name one
// level up. Links and bookmarks to the old address 404ed from the move until
// the Stats tab showed them. 301, so search engines move their index too.
//
// The old site also had /favicon.png; the platform emits favicon.ico.
//
// Runtime: cloudfront-js-2.0. No imports, no state.

function redirect(location) {
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: location },
      'cache-control': { value: 'max-age=86400' },
    },
  };
}

function queryString(qs) {
  var parts = [];
  for (var k in qs) {
    var v = qs[k];
    var all = v.multiValue ? v.multiValue : [v];
    for (var i = 0; i < all.length; i++) {
      parts.push(all[i].value === '' ? k : k + '=' + all[i].value);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri === '/articles' || uri === '/articles/') return redirect('/' + queryString(request.querystring));
  if (uri.indexOf('/articles/') === 0) {
    return redirect('/' + uri.slice('/articles/'.length) + queryString(request.querystring));
  }
  if (uri === '/favicon.png') return redirect('/favicon.ico');

  // mirror-router.js: "/" and "/dir/" mean index.html, which S3's REST
  // endpoint will not do on its own.
  if (uri.length === 0 || uri.charAt(uri.length - 1) === '/') request.uri = uri + 'index.html';
  return request;
}
