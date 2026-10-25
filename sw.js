const CACHE_NAME = 'anime-together-cache-v4';
const DRIVE_STREAM_ROUTE = '__drive_stream__';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// الموقع يتأكد أن هذه النسخة من المشغّل تدعم بث Drive قبل التشغيل
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'DRIVE_SW_PING' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: 'DRIVE_SW_READY' });
  }
});

async function proxyDriveStream(request, localUrl, fileId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return new Response('Invalid Google Drive file ID.', { status: 400 });
  }

  const accessToken = localUrl.searchParams.get('access_token');
  if (!accessToken) {
    return new Response('Google Drive authorization is required.', { status: 401 });
  }

  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  // نمرر نطاق البايتات كما طلبه المتصفح بالضبط: سفاري (آيفون/آيباد) يطلب أولاً bytes=0-1
  // ويرفض الفيديو نهائياً إذا رجع له حجم مختلف عما طلب
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  const resourceKey = localUrl.searchParams.get('resource_key');
  if (resourceKey) headers.set('X-Goog-Drive-Resource-Keys', `${fileId}/${resourceKey}`);

  const apiUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  apiUrl.searchParams.set('alt', 'media');
  apiUrl.searchParams.set('supportsAllDrives', 'true');

  try {
    // تمرير استجابة Google كما هي (206 وContent-Range) ليعمل التقديم والبث على أجزاء
    return await fetch(apiUrl.href, { method: 'GET', headers, cache: 'no-store', redirect: 'follow' });
  } catch (error) {
    return new Response('Google Drive stream request failed.', { status: 502 });
  }
}

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  const driveMatch = requestUrl.pathname.match(new RegExp(`/${DRIVE_STREAM_ROUTE}/([^/]+)$`));

  // مسار محلي؛ رمز الدخول لا يخرج إلى الاستضافة، يذهب لـ Google فقط
  if (requestUrl.origin === self.location.origin && driveMatch && event.request.method === 'GET') {
    event.respondWith(proxyDriveStream(event.request, requestUrl, decodeURIComponent(driveMatch[1])));
    return;
  }

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
