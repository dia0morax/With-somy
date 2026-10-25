const CACHE_NAME = 'anime-together-cache-v5';
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

  let upstream;
  try {
    upstream = await fetch(apiUrl.href, { method: 'GET', headers, cache: 'no-store', redirect: 'follow' });
  } catch (error) {
    return new Response('Google Drive stream request failed.', { status: 502 });
  }
  if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'text/plain' } });

  // سفاري (آيفون/آيباد) يقبل الفيديو فقط إذا رجع له 206 بنفس البايتات المطلوبة بالضبط ومع Content-Range صحيح.
  // رد Google من نطاق آخر قد يخفي Content-Range، فنبني رداً محلياً بالرؤوس الصحيحة محسوبة من حجم الملف.
  const size = Number(localUrl.searchParams.get('size')) || 0;
  const out = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') || localUrl.searchParams.get('type') || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  });
  const m = range && range.match(/bytes=(\d+)-(\d*)/);
  if (!m || !size) {
    const len = upstream.headers.get('Content-Length');
    if (len) out.set('Content-Length', len);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  const start = Number(m[1]);
  const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
  if (start > end) {
    out.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers: out });
  }
  out.set('Content-Range', `bytes ${start}-${end}/${size}`);
  out.set('Content-Length', String(end - start + 1));
  // إذا تجاهل Google النطاق ورجّع الملف كاملاً (200) نقص البايتات المطلوبة بأنفسنا
  const body = upstream.status === 206 ? upstream.body : sliceStream(upstream.body, start, end - start + 1);
  return new Response(body, { status: 206, headers: out });
}

// يمرر فقط `length` بايت تبدأ من `skip` من تدفق البيانات
function sliceStream(stream, skip, length) {
  const reader = stream.getReader();
  let pos = 0, sent = 0;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done || sent >= length) { controller.close(); reader.cancel().catch(() => {}); return; }
        const chunkStart = Math.max(0, skip - pos);
        pos += value.length;
        if (chunkStart >= value.length) continue;
        const part = value.subarray(chunkStart, chunkStart + (length - sent));
        sent += part.length;
        controller.enqueue(part);
        if (sent >= length) { controller.close(); reader.cancel().catch(() => {}); }
        return;
      }
    },
    cancel() { reader.cancel().catch(() => {}); }
  });
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
