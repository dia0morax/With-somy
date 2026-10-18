const CACHE_NAME = 'anime-together-cache-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // استثناء وتمرير مباشر لطلبات الرفع والتحميل والـ API لمنع انقطاع الرفع في تطبيق سطح المكتب
  if (
    event.request.method !== 'GET' ||
    url.includes('backblazeb2.com') ||
    url.includes('workers.dev') ||
    url.includes('firebaseio.com') ||
    url.includes('googleapis.com') ||
    url.startsWith('blob:')
  ) {
    return; // ترك الطلب يمر مباشرة إلى الشبكة دون أي اعتراض من التطبيق
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
