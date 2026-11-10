
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 12000;

function publicIP(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    return !(
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 192 && p[1] === 0) ||
      (p[0] === 198 && [18, 19].includes(p[1])) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0)
    );
  }

  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();
    if (s.startsWith('::ffff:')) {
      return publicIP(s.substring(7));
    }

    return !(
      s === '::1' ||
      s === '::' ||
      s.startsWith('fc') ||
      s.startsWith('fd') ||
      s.startsWith('fe8') ||
      s.startsWith('fe9') ||
      s.startsWith('fea') ||
      s.startsWith('feb') ||
      s.startsWith('ff')
    );
  }

  return false;
}

async function checkUrl(input) {
  const u = new URL(input);

  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    !['', '80', '443'].includes(u.port)
  ) {
    throw new Error('Unsupported article URL');
  }

  const h = u.hostname.toLowerCase();

  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.test')
  ) {
    throw new Error('Unsupported host');
  }

  const addresses = await dns.lookup(h, { all: true });

  if (
    !addresses.length ||
    addresses.some(a => !publicIP(a.address))
  ) {
    throw new Error('Private addresses are not allowed');
  }

  return u;
}

function sanitize(root, base) {
  root.querySelectorAll(
    'script,style,iframe,object,embed,form,input,button,' +
    'video,audio,svg,canvas,link,meta,base,noscript'
  ).forEach(n => n.remove());

  for (const el of [...root.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();

      if (
        name.startsWith('on') ||
        ['style', 'srcset', 'srcdoc', 'formaction',
         'poster', 'id', 'class'].includes(name)
      ) {
        el.removeAttribute(a.name);
      }
    }

    if (el.tagName === 'IMG') {
      try {
        const u = new URL(
          el.getAttribute('src') || '',
          base
        );

        if (!['https:', 'http:'].includes(u.protocol)) {
          el.remove();
        } else {
          el.setAttribute('src', u.href);
          el.setAttribute('loading', 'lazy');
          el.setAttribute('referrerpolicy', 'no-referrer');
        }
      } catch {
        el.remove();
      }
    }

    if (el.tagName === 'A') {
      try {
        const u = new URL(
          el.getAttribute('href') || '',
          base
        );

        if (!['http:', 'https:'].includes(u.protocol)) {
          el.removeAttribute('href');
        } else {
          el.setAttribute('href', u.href);
          el.setAttribute('target', '_blank');
          el.setAttribute(
            'rel',
            'noopener noreferrer'
          );
        }
      } catch {
        el.removeAttribute('href');
      }
    } else if (el.hasAttribute('href')) {
      el.removeAttribute('href');
    }

    if (
      el.tagName !== 'IMG' &&
      el.hasAttribute('src')
    ) {
      el.removeAttribute('src');
    }
  }

  return root.innerHTML;
}

async function readLimitedResponse(response) {
  const length = Number(
    response.headers.get('content-length') || 0
  );

  if (length > MAX_BYTES) {
    throw new Error('Article is too large');
  }

  if (!response.body) {
    throw new Error('Empty publisher response');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error('Article is too large');
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

exports.handler = async event => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: 'Method not allowed'
    };
  }

  try {
    const raw = event.queryStringParameters?.url;

    if (!raw || raw.length > 3000) {
      throw new Error('Missing or oversized URL');
    }

    let u = await checkUrl(raw);
    let response;

    for (let i = 0; i < 4; i++) {
      response = await fetch(u.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; RedoubtReader/1.0)',
          'Accept':
            'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.8'
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (i === 3) {
          throw new Error('Too many redirects');
        }

        const location = response.headers.get('location');

        if (!location) {
          throw new Error('Invalid publisher redirect');
        }

        u = await checkUrl(
          new URL(location, u).href
        );

        await response.body?.cancel();
        continue;
      }

      break;
    }

    if (!response.ok) {
      throw new Error(
        'Publisher returned HTTP ' + response.status
      );
    }

    if (
      !/^text\/html\b/i.test(
        response.headers.get('content-type') || ''
      )
    ) {
      throw new Error(
        'Source is not an HTML article'
      );
    }

    const html = await readLimitedResponse(response);

    const dom = new JSDOM(html, {
      url: u.href
    });

    const article = new Readability(
      dom.window.document,
      { charThreshold: 200 }
    ).parse();

    if (
      !article?.content ||
      !article.textContent?.trim()
    ) {
      throw new Error(
        'No readable article text found'
      );
    }

    const clean = new JSDOM(
      `<main>${article.content}</main>`,
      { url: u.href }
    );

    const content = sanitize(
      clean.window.document.querySelector('main'),
      u.href
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type':
          'application/json; charset=utf-8',
        'Cache-Control':
          'private, max-age=120'
      },
      body: JSON.stringify({
        title: article.title,
        byline: article.byline,
        siteName: article.siteName,
        published: article.publishedTime,
        content
      })
    };

  } catch (e) {
    let message = e.message ||
      'Article could not be loaded';

    if (
      e.name === 'TimeoutError' ||
      e.name === 'AbortError'
    ) {
      message = 'Article request timed out';
    }

    return {
      statusCode: 422,
      headers: {
        'Content-Type':
          'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify({
        error: message
      })
    };
  }
};
