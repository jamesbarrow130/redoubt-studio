
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 3;

function isPublicIP(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    return true;
  }
  if (family === 6) {
    const s = address.toLowerCase();
    if (s === '::' || s === '::1') return false;
    if (s.startsWith('::ffff:')) {
      const tail = s.slice(7);
      if (net.isIP(tail) === 4) return isPublicIP(tail);
      return false;
    }
    const first = parseInt(s.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false;
    if ((first & 0xffc0) === 0xfe80) return false;
    if ((first & 0xff00) === 0xff00) return false;
    if (s.startsWith('2001:db8:')) return false;
    if (!s.startsWith('2') && !s.startsWith('3')) return false;
    return true;
  }
  return false;
}

function validateUrl(input) {
  const u = new URL(input);
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username || u.password ||
    !['', '80', '443'].includes(u.port)
  ) {
    throw new Error('Unsupported article URL');
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !host || host === 'localhost' ||
    ['.localhost', '.local', '.internal', '.test']
      .some(s => host.endsWith(s))
  ) {
    throw new Error('Unsupported article host');
  }
  if (net.isIP(host)) {
    throw new Error('Direct IP addresses are not supported');
  }
  return u;
}

async function resolvePublicAddresses(hostname) {
  const addresses = await dns.lookup(hostname, {
    all: true,
    verbatim: true
  });
  const allowed = addresses.filter(a => isPublicIP(a.address));
  if (!addresses.length || !allowed.length) {
    throw new Error(`No public IP address available for ${hostname}`);
  }
  if (allowed.length !== addresses.length) {
    throw new Error(`Host ${hostname} has a restricted DNS address`);
  }
  return allowed;
}

function sanitize(root, base) {
  root.querySelectorAll(
    'script,style,iframe,object,embed,form,input,button,' +
    'video,audio,svg,canvas,link,meta,base,noscript'
  ).forEach(n => n.remove());

  for (const el of [...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith('on') ||
        ['style','srcset','srcdoc','formaction','poster','id','class']
          .includes(name)
      ) {
        el.removeAttribute(attr.name);
      }
    }

    if (el.tagName === 'IMG') {
      try {
        const url = new URL(el.getAttribute('src') || '', base);
        if (!['http:', 'https:'].includes(url.protocol)) {
          el.remove();
        } else {
          el.setAttribute('src', url.href);
          el.setAttribute('loading', 'lazy');
          el.setAttribute('referrerpolicy', 'no-referrer');
        }
      } catch {
        el.remove();
      }
    }

    if (el.tagName === 'A') {
      try {
        const url = new URL(el.getAttribute('href') || '', base);
        if (!['http:', 'https:'].includes(url.protocol)) {
          el.removeAttribute('href');
        } else {
          el.setAttribute('href', url.href);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      } catch {
        el.removeAttribute('href');
      }
    } else if (el.hasAttribute('href')) {
      el.removeAttribute('href');
    }

    if (el.tagName !== 'IMG' && el.hasAttribute('src')) {
      el.removeAttribute('src');
    }
  }
  return root.innerHTML;
}

async function readLimited(response) {
  const declared = Number(
    response.headers.get('content-length') || 0
  );
  if (declared > MAX_BYTES) {
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
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const raw = event.queryStringParameters?.url;
    if (!raw || raw.length > 3000) {
      throw new Error('Missing or oversized URL');
    }

    let current = validateUrl(raw);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let html;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const { Agent, fetch: undiciFetch } = require('undici');
      const addresses = await resolvePublicAddresses(current.hostname);

      const agent = new Agent({
        connect: {
          lookup(host, options, callback) {
            const match = addresses.find(
              a => a.family === options.family
            ) || addresses[0];
            callback(null, match.address, match.family);
          }
        }
      });

      try {
        const response = await undiciFetch(current.href, {
          dispatcher: agent,
          redirect: 'manual',
          signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; RedoubtReader/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.8'
          }
        });

        if ([301,302,303,307,308].includes(response.status)) {
          if (i === MAX_REDIRECTS) {
            throw new Error('Too many redirects');
          }
          const location = response.headers.get('location');
          if (!location) {
            throw new Error('Invalid publisher redirect');
          }
          current = validateUrl(new URL(location, current).href);
          await response.body?.cancel();
          continue;
        }

        if (!response.ok) {
          throw new Error(
            'Publisher returned HTTP ' + response.status
          );
        }

        if (!/^text\/html\b/i.test(
          response.headers.get('content-type') || ''
        )) {
          throw new Error('Source is not an HTML article');
        }

        html = await readLimited(response);
        break;
      } finally {
        await agent.close();
      }
    }

    if (!html) throw new Error('No article HTML received');

    const dom = new JSDOM(html, { url: current.href });
    const article = new Readability(
      dom.window.document,
      { charThreshold: 200 }
    ).parse();

    if (!article?.content || !article.textContent?.trim()) {
      throw new Error('No readable article text found');
    }

    const clean = new JSDOM(
      `<main>${article.content}</main>`,
      { url: current.href }
    );
    const content = sanitize(
      clean.window.document.querySelector('main'),
      current.href
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=120'
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
    const message = ['TimeoutError','AbortError'].includes(e.name)
      ? 'Article request timed out'
      : (e.message || 'Article could not be loaded');

    return {
      statusCode: 422,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify({ error: message })
    };
  }
};
