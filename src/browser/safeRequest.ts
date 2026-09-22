export class SafeRequestError extends Error {}

declare const chrome: any;

const fetchViaExtension = async (url: string, headers: Record<string, string>): Promise<Response> => {
  const result = await chrome.runtime.sendMessage({
    type: 'boomstream-fetch',
    url,
    headers
  });
  if (!result || result.error) {
    throw new SafeRequestError(result?.error || 'Background request failed');
  }

  const binary = atob(result.body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Response(bytes, { status: result.status, statusText: result.statusText });
};

const safeRequest = async (url: string, headers = {}, triesLeft = 10) => {
  if (triesLeft === 0) {
    throw new SafeRequestError();
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers,
      referrerPolicy: 'unsafe-url'
    });
  } catch (error) {
    // Content scripts obey the page's CORS policy, even with host permissions.
    // Retry only Boomstream CDN requests from the extension service worker.
    const target = new URL(url);
    if (!(error instanceof TypeError) || !target.hostname.endsWith('.boomstream.com')) {
      throw error;
    }
    resp = await fetchViaExtension(url, headers);
  }
  if (resp.status > 401) {
    console.log(`failed request ${ url } with status ${ resp.status }, retrying`);
    await new Promise(res => setTimeout(res, Math.random() * 60000));
    return safeRequest(url, headers, triesLeft - 1);
  }

  return resp;
};

export default safeRequest;
