const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function stripTrailingSlash(url) {
  return url.replace(/\/$/, '');
}

function replaceLocalHost(url, host) {
  return url.replace(/\/\/(localhost|127\.0\.0\.1)/, `//${host}`);
}

function normalizeMicPageUrl(url) {
  if (!url) return null;

  const trimmed = url.trim().replace(/\/$/, '');
  return trimmed.endsWith('index.html') ? trimmed : `${trimmed}/index.html`;
}

function isPublicUrl(url) {
  return /^https?:\/\//.test(url) && !url.includes('localhost') && !url.includes('127.0.0.1');
}

export async function resolveNetworkUrls() {
  const configuredApi = stripTrailingSlash(import.meta.env.VITE_API_URL || 'http://localhost:3001');
  const configuredMic = normalizeMicPageUrl(import.meta.env.VITE_MIC_PAGE_URL);
  const vitePort = window.location.port || '5173';
  const lanHostFromEnv = import.meta.env.VITE_LAN_HOST?.trim();

  // Produzione: pagina mic su GitHub Pages + backend su Render (funziona da qualsiasi rete).
  if (configuredMic && isPublicUrl(configuredMic)) {
    return {
      apiUrl: configuredApi,
      micBase: configuredMic,
      lanIp: null,
      isPhoneReady: isPublicUrl(configuredApi),
      mode: 'production',
    };
  }

  if (lanHostFromEnv) {
    return {
      apiUrl: replaceLocalHost(configuredApi, lanHostFromEnv),
      micBase: `http://${lanHostFromEnv}:${vitePort}/mic/index.html`,
      lanIp: lanHostFromEnv,
      isPhoneReady: true,
      mode: 'lan',
    };
  }

  const currentHost = window.location.hostname;

  if (!LOCAL_HOSTS.has(currentHost)) {
    const basePath = import.meta.env.BASE_URL || '/';

    return {
      apiUrl: stripTrailingSlash(configuredApi),
      micBase: new URL(`${basePath}mic/index.html`, `${window.location.origin}/`).href,
      lanIp: currentHost,
      isPhoneReady: isPublicUrl(configuredApi),
      mode: 'hosted',
    };
  }

  try {
    const response = await fetch(`${configuredApi}/network-info`);
    if (response.ok) {
      const data = await response.json();
      if (data.lanIp) {
        return {
          apiUrl: `http://${data.lanIp}:${data.port || 3001}`,
          micBase: `http://${data.lanIp}:${vitePort}/mic/index.html`,
          lanIp: data.lanIp,
          isPhoneReady: true,
          mode: 'lan',
        };
      }
    }
  } catch {
    // Backend non raggiungibile in locale.
  }

  return {
    apiUrl: configuredApi,
    micBase: `${window.location.origin}/mic/index.html`,
    lanIp: null,
    isPhoneReady: false,
    mode: 'local',
  };
}

export function buildMicPageUrl(micBase, apiUrl, uploadSecret) {
  const url = new URL(micBase, window.location.href);
  url.searchParams.set('api', apiUrl);

  if (uploadSecret) {
    url.searchParams.set('secret', uploadSecret);
  }

  return url.toString();
}
