// Runs the Node-style (req, res) handler behind a Web Request -> Response function (Netlify Functions).
export function webHandler(nodeHandler) {
  return async function (request, context) {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    if (context?.ip) headers['x-forwarded-for'] = context.ip;
    const req = {
      method: request.method,
      url: url.pathname + url.search,
      headers,
      body: request.method === 'POST' ? await request.text() : undefined,
      socket: null,
    };
    return new Promise((resolve, reject) => {
      const out = new Headers();
      const res = {
        statusCode: 200,
        setHeader: (k, v) => out.set(k, String(v)),
        end: (data) => resolve(new Response(res.statusCode === 204 ? null : data ?? null, { status: res.statusCode, headers: out })),
      };
      Promise.resolve(nodeHandler(req, res)).catch(reject);
    });
  };
}
