// Corre en el contexto de la página (world: MAIN).
// Envuelve fetch para leer, sin modificarlas, las respuestas de claude.ai
// y avisar al content script cuando llegan datos de límite/uso.
(() => {
  if (window.__claudeUsoHook) return;
  window.__claudeUsoHook = true;

  const post = (kind, payload, conv) =>
    window.postMessage({ source: 'claude-uso-ext', kind, payload, conv: conv || null }, location.origin);

  const origFetch = window.fetch;

  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || String(req || '');
      const method = ((args[1] && args[1].method) || (req && req.method) || 'GET').toUpperCase();

      if (url.includes('/api/')) {
        // Cabeceras que parezcan de límites
        const headers = {};
        res.headers.forEach((v, k) => {
          if (/limit|usage|remaining|reset/i.test(k)) headers[k] = v;
        });
        if (Object.keys(headers).length) post('headers', { url, headers });

        // Mensaje enviado al chat: leer el stream (SSE) de la respuesta
        if (method === 'POST' && /completion/.test(url)) {
          // Id del chat, para medir el costo por conversación (solo el id, no el contenido)
          const cm = /chat_conversations\/([0-9a-f-]{36})/i.exec(url);
          const conv = cm ? cm[1] : null;
          post('sent', { url }, conv);
          if (res.ok) readStream(res.clone(), conv);
          else readError(res.clone(), conv); // p. ej. 429 al llegar al límite: suele traer la hora de reinicio
        }
      }
    } catch (e) {
      /* nunca romper la página */
    }
    return res;
  };

  async function readStream(res, conv) {
    let sawData = false, sawLimit = false;
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          sawData = true;
          // Filtro barato antes de JSON.parse: la gran mayoría de líneas son trozos de texto de la respuesta
          if (!/limit|usage/i.test(line)) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev && /limit|usage/i.test(ev.type || '')) {
              sawLimit = true;
              post('limit', ev, conv);
            }
          } catch (e) {
            /* línea que no es JSON */
          }
        }
      }
      // Stream terminado con normalidad: sirve para detectar si el aviso de límite dejó de llegar
      if (sawData) post('streamEnd', { sawLimit }, conv);
    } catch (e) {
      /* stream cortado (p. ej. el usuario detuvo la respuesta): no cuenta */
    }
  }

  // Los errores a veces traen el JSON útil dentro de un texto (p. ej. error.message = "{\"resetsAt\":…}")
  function deepParse(v, depth) {
    if (depth > 6) return v;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.length < 100000 && (s[0] === '{' || s[0] === '[')) {
        try { return deepParse(JSON.parse(s), depth + 1); } catch (e) { return v; }
      }
      return v;
    }
    if (v && typeof v === 'object') {
      const out = Array.isArray(v) ? [] : {};
      for (const [k, x] of Object.entries(v)) out[k] = deepParse(x, depth + 1);
      return out;
    }
    return v;
  }

  // Cuerpo de una respuesta con error: si es JSON (o SSE con JSON), se manda para buscar datos de límite.
  // Si no los trae, el content script la ignora (no cuenta como "formato cambiado").
  async function readError(res, conv) {
    try {
      const text = await res.text();
      if (!text || text.length > 200000) return;
      let body = null;
      try {
        body = JSON.parse(text);
      } catch (e) {
        for (const line of text.split('\n')) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          try { body = JSON.parse(l.slice(5).trim()); break; } catch (e2) { /* seguir */ }
        }
      }
      if (body && typeof body === 'object') post('errorBody', { status: res.status, body: deepParse(body, 0) }, conv);
    } catch (e) {
      /* ignorar */
    }
  }
})();
