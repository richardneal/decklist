/* exported Report */

// Counts what went wrong, never who it happened to: each event is a name from a fixed
// list and up to three short codes, posted to the site's own /api/event, which adds the
// browser family and whether it's a phone. Nothing from the form goes out: no names,
// no event, no deck, no card names, no URLs. Nothing is sent while the browser asks for
// Global Privacy Control, and docs.html lists every field.
var Report = {
  url: '/api/event',
  // A page sends at most this many events, and each one once
  limit: 20,
  sent: new Set(),

  // Whether events go out at all: not from a page opened as a file, and not with
  // Global Privacy Control
  enabled: function() {
    return !navigator.globalPrivacyControl && typeof navigator.sendBeacon === 'function' &&
      /^https?:$/.test(location.protocol);
  },

  event: function(name, ...details) {
    var codes = details.map(function(detail) { return String(detail ?? '').slice(0, 120); });
    var key = JSON.stringify([name, codes]);
    if (!this.enabled() || this.sent.size >= this.limit || this.sent.has(key)) return;
    this.sent.add(key);
    try {
      navigator.sendBeacon(this.url, new Blob([JSON.stringify({ e: name, d: codes })], { type: 'text/plain' }));
    } catch (_) {
      // a beacon that can't be sent is dropped
    }
  },

  // An error message without anything it might have quoted: quoted text and links
  // become …, and long numbers 0
  scrub: function(message) {
    return String(message || '').replace(/https?:\/\/\S+/g, '…').replace(/(["'`‘’“”]).*?\1/g, '…')
      .replace(/\d{3,}/g, '0').slice(0, 100);
  },

  // A script or file of this site, as its path, or null for anything else (a browser
  // extension, say), which isn't ours to report
  ownFile: function(url) {
    try {
      var parsed = new URL(url, location.href);
      return parsed.origin === location.origin ? parsed.pathname : null;
    } catch (_) {
      return null;
    }
  },

  // The kind of an import or upload failure, from the error the page shows
  kind: function(error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    // fetch rejects with a TypeError when it can't reach the server
    if (error.name === 'TypeError') return 'network';
    return 'failed';
  }
};

// Uncaught errors in the site's own scripts, and its files that failed to load (the
// card data, jsPDF, PDF.js); the capture phase sees a script's load error, which
// doesn't bubble
window.addEventListener('error', function(event) {
  var target = event.target;
  if (target && target !== window && (target.src || target.href)) {
    var path = Report.ownFile(target.src || target.href);
    if (path) Report.event('load', path);
    return;
  }
  var file = Report.ownFile(event.filename);
  if (file) Report.event('error', file + ':' + event.lineno + ':' + event.colno, Report.scrub(event.message));
}, true);

window.addEventListener('unhandledrejection', function(event) {
  var reason = event.reason || {};
  var stack = String(reason.stack || '');
  var match = stack.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
  var file = match && Report.ownFile(match[1]);
  if (file) Report.event('error', file + ':' + match[2] + ':' + match[3], Report.scrub(reason.message || reason));
});
