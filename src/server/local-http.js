// Loopback binding keeps the LAN out; Host and Origin checks keep other websites
// from using the browser to drive this terminal-control API (including rebinding).
// Native clients such as the hook and WKWebView's notification stream have no Origin.
export function localRequestAllowed(headers, port) {
  const host = String(headers.host || '').toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].some(name => host === `${name}:${port}`)) return false;
  if (headers.origin !== undefined && headers.origin !== `http://${host}`) return false;
  const site = headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}
