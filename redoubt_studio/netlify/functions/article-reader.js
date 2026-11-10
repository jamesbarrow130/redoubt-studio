
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');
const { Agent, fetch: undiciFetch } = require('undici');

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 3;

function publicIP(ip) {
  const version = net.isIP(ip);

  if (version === 4) {
    const [a, b, c] = ip.split('.').map(Number);

    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 ||
        (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 192 && b === 88 && c === 99)
    );
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();

    if (normalized.startsWith('::ffff:')) {
      return publicIP(normalized.slice(7));
    }

    if (normalized === '::' || normalized === '::1') {
      return false;
    }

    const first = parseInt(
      normalized.split(':')[0] || '0', 16
    );

    return (
      (first & 0xfe00) !== 0xfc00 &&
      (first & 0xffc0) !== 0xfe80 &&
      (first & 0xff00) !== 0xff00 &&
      !normalized.startsWith('2001:db8:') &&
      (normalized.startsWith('2') ||
       normalized.startsWith('3'))
    );
  }

  return false;
}

function validateURL(input) {
  const u = new URL(input);
  const host = u.hostname.toLowerCase().replace(/\.$/, '');

  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    !['', '80', '443'].includes(u.port) ||
    net.isIP(host) ||
    host === 'localhost' ||
    ['.localhost', '.local', '.internal', '.test']
      .some(s => host.endsWith(s))
  ) {
    throw new Error('Unsupported article URL');
  }

  return u;
}

async function addressesFor(host) {
  const addresses = await dns.lookup(host, { all: true });

  if (
    !addresses.length ||
    addresses.some(a => !publicIP(a.address))
  ) {
    throw new Error('Private addresses are not allowed');
  }

  return addresses;
}

function sanitize(root, base) {
  root.querySelectorAll(
    'script,style,iframe,object,embed,form,input,button,' +
    'video,audio,svg,canvas,link,meta,base,noscript'
  ).forEach(n => n.remove());

  for (const el of [...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (
        attr.name.toLowerCase().startsWith('on') ||
        [
          'style', 'srcset', 'srcdoc', 'formaction',
          'poster', 'id', 'class'
        ].includes(attr.name.toLowerCase())
      ) {
        el.removeAttribute(attr.name);
      }
    }

    if (el.tagName === 'IMG') {
      try {
        const u = new URL(
          el.getAttribute('src') || '', base
        );

        if (!['http:', 'https:'].includes(u.protocol)) {
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
          el.getAttribute('href') || '', base
        );

        if (!['http:', 'https:'].includes(u.protocol)) {
          el.removeAttribute('href');
        } else {
          el.setAttribute('href', u.href);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
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

async function limitedText(response) {
  if (
    Number(response.headers.get('content-length') || 0)
      > MAX_BYTES
  ) {
    throw new Error('Article is too large');
  }

  if (!response.body) {
    throw new Error('Empty publisher response');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      size += value.byteLength;

      if (size > MAX_BYTES) {
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

    let current = validateURL(raw);
    let html;

    const signal = AbortSignal.timeout(TIMEOUT_MS);

    for (
      let redirect = 0;
      redirect <= MAX_REDIRECTS;
      redirect++
    ) {
      const addresses = await addressesFor(
        current.hostname
      );

      const agent = new Agent({
        connect: {
          lookup(_hostname, _options, callback) {
            // Use a previously vetted public address.
            const selected = addresses[0];

            callback(
              null,
              selected.address,
              selected.family
            );
          }
        }
      });

      try {
        const response = await undiciFetch(
          current.href,
          {
            dispatcher: agent,
            redirect: 'manual',
            signal,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (compatible; RedoubtReader/1.0)',
              'Accept':
                'text/html,application/xhtml+xml',
              'Accept-Language':
                'en-US,en;q=0.8'
            }
          }
        );

        if (
          [301, 302, 303, 307, 308]
            .includes(response.status)
        ) {
          if (redirect === MAX_REDIRECTS) {
            throw new Error('Too many redirects');
          }

          const location =
            response.headers.get('location');

          if (!location) {
            throw new Error(
              'Invalid publisher redirect'
            );
          }

          current = validateURL(
            new URL(location, current).href
          );

          await response.body?.cancel();
          continue;
        }

        if (!response.ok) {
          throw new Error(
            'Publisher returned HTTP ' +
            response.status
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

        html = await limitedText(response);
        break;

      } finally {
        await agent.close();
      }
    }

    if (!html) {
      throw new Error('No article HTML received');
    }

    const dom = new JSDOM(html, {
      url: current.href
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
      { url: current.href }
    );

    const content = sanitize(
      clean.window.document.querySelector('main'),
      current.href
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
    const error = [
      'TimeoutError',
      'AbortError'
    ].includes(e.name)
      ? 'Article request timed out'
      : (
          e.message ||
          'Article could not be loaded'
        );

    return {
      statusCode: 422,
      headers: {
        'Content-Type':
          'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify({ error })
    };
  }
};
