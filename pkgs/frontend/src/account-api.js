import { requestJson } from './request.js?v=98';
import { API_ROOT } from './api-root.js?v=98';
export { API_ROOT };
export function accountHint() {
  try {
    const id = JSON.parse(new URLSearchParams(window.Telegram?.WebApp?.initData).get('user')).id;
    return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  }
  catch { return null; }
}
export async function accountRequest(path, body, method = body === undefined ? 'GET' : 'POST', options = {}) {
  const initData = window.Telegram?.WebApp?.initData;
  if (!initData) throw new Error('Откройте приложение через Telegram, чтобы сохранять прогресс.');
  return requestJson(`${API_ROOT}/${path}`, {
    // Fetch keepalive has a 64 KiB body budget; large documents use normal fetch.
    ...(options.keepalive && new TextEncoder().encode(JSON.stringify(body)).length < 60000 ? { keepalive: true } : {}),
    method, headers: { 'Content-Type': 'application/json', Authorization: `tma ${initData}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, async (...args) => {
    const response = await fetch(...args);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || `Ошибка сервера: ${response.status}`), { status: response.status });
    }
    return response;
  });
}
