// PriceWatch passive capture (content script). Registered dynamically by the
// service worker for the origins of tracked products only. After the page
// settles, scrape it with the shared parse-dom.js scraper and hand the result
// to the service worker, which POSTs it observeOnly — a page that isn't a
// tracked product is a server-side no-op.
(() => {
  if (globalThis.__pwCaptureRan) return;
  globalThis.__pwCaptureRan = true;

  const send = () => {
    let scraped = null;
    try {
      scraped = globalThis.__pwScrapePage ? globalThis.__pwScrapePage() : null;
    } catch {
      return;
    }
    if (!scraped || scraped.price == null) return;
    try {
      chrome.runtime.sendMessage({ kind: 'pw-passive-capture', scraped });
    } catch {
      // Extension was reloaded out from under this page — ignore.
    }
  };

  // Store pages hydrate prices late; give the page a quiet moment first.
  if (document.readyState === 'complete') setTimeout(send, 2500);
  else addEventListener('load', () => setTimeout(send, 2500), { once: true });
})();
