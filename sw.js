const CACHE_NAME = 'anime-together-cache-v2';
const DRIVE_STREAM_ROUTE = '__drive_stream__';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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

  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    'Cache-Control': 'no-store'
  });
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  const resourceKey = localUrl.searchParams.get('resource_key');
  if (resourceKey) {
    headers.set('X-Goog-Drive-Resource-Keys', `${fileId}/${resourceKey}`);
  }

  const apiUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  apiUrl.searchParams.set('alt', 'media');
  apiUrl.searchParams.set('supportsAllDrives', 'true');

  try {
    // تمرير استجابة Google كما هي، بما فيها 206 وContent-Range؛ هذا يتيح seek وبث أجزاء الملف.
    return await fetch(apiUrl.href, {
      method: 'GET',
      headers,
      cache: 'no-store',
      redirect: 'follow'
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Google Drive stream request failed.',
      message: error && error.message ? error.message : 'Network error'
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  const driveRoutePattern = new RegExp(`/${DRIVE_STREAM_ROUTE}/([^/]+)$`);
  const driveMatch = requestUrl.pathname.match(driveRoutePattern);

  // مسار محلي مؤقت؛ رمز OAuth لا يخرج إلى Firebase ولا يُرسل إلى GitHub Pages.
  if (
    requestUrl.origin === self.location.origin &&
    driveMatch &&
    event.request.method === 'GET'
  ) {
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
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
