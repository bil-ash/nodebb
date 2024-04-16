importScripts('/appcache-polyfill-sw.js');

self.addEventListener('fetch', (event) => {
  // Alternatively, examine event.request and only use the
  // appcachePolyfill.handle() logic for a subset of requests.
  //first check if it is for share target, if()...
  //share target logic here
  //else
  event.respondWith(appcachePolyfill.handle(event));
});