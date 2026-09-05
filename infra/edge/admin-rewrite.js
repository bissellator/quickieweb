// CloudFront Function, viewer request, attached to the /admin* behavior.
//
// Exists for one reason: DefaultRootObject applies to "/" and nothing else.
// CloudFront does not resolve directory indexes for subdirectories, so once
// /admin* is served from S3, a request for /admin/ asks S3 for a key literally
// named "admin/", finds no object, and -- because the bucket policy grants
// GetObject but not ListBucket -- comes back 403 rather than 404.
//
// Runtime: cloudfront-js-2.0.

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Bare /admin has no trailing slash, so every relative path on the page
  // would resolve one level too high. Redirect rather than rewrite.
  if (uri === '/admin') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { 'location': { value: '/admin/' } }
    };
  }

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  }

  return request;
}
