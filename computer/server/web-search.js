'use strict';

const fs = require('node:fs');
const path = require('node:path');

let puppeteerExtra = null;
let stealthPlugin = null;
try {
  puppeteerExtra = require('puppeteer-extra');
  stealthPlugin = require('puppeteer-extra-plugin-stealth');
  if (puppeteerExtra && stealthPlugin) {
    puppeteerExtra.use(stealthPlugin());
  }
} catch (err) {
  console.warn('[WebSearch] Puppeteer-extra o Stealth non disponibili:', err.message);
}

const BROWSER_CANDIDATE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe')
];

function findBrowserExecutable() {
  for (const candidate of BROWSER_CANDIDATE_PATHS) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Robust HTTP fallback for search if browser fails or is not found
 */
async function fallbackHttpSearch(query, maxResults = 5, page = 1) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error(`Ricerca HTTP fallita con stato ${res.status}`);
  const html = await res.text();

  const allResults = [];
  const linkRegex = /<a class="result__url" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null && allResults.length < 50) {
    let rawUrl = match[1];
    if (rawUrl.includes('uddg=')) {
      try {
        const u = new URL('https://duckduckgo.com' + rawUrl);
        rawUrl = decodeURIComponent(u.searchParams.get('uddg') || rawUrl);
      } catch {}
    }
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    allResults.push({
      title: match[2].replace(/<[^>]+>/g, '').trim() || rawUrl,
      url: rawUrl,
      snippet
    });
  }

  const offset = Math.max(0, (page - 1) * maxResults);
  return allResults.slice(offset, offset + maxResults);
}

/**
 * Robust HTTP fallback for reading and extracting clean text and links from a web page
 */
async function fallbackHttpPage(url, maxChars = 8000) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!res.ok) throw new Error(`Navigazione HTTP fallita con stato ${res.status}`);
  const html = await res.text();

  // Title
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  // Extract links
  const links = [];
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null && links.length < 25) {
    const rawHref = match[1].trim();
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) continue;
    try {
      const resolved = new URL(rawHref, url).href;
      const text = match[2].replace(/<[^>]+>/g, '').trim();
      if (text && !links.some(l => l.url === resolved)) {
        links.push({ text: text.slice(0, 100), url: resolved });
      }
    } catch {}
  }

  // Extract clean text
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const isTruncated = text.length > maxChars;
  if (isTruncated) {
    text = text.slice(0, maxChars) + '... [contenuto troncato]';
  }

  return {
    url,
    title,
    content: text,
    links,
    isTruncated,
    engine: 'http-fallback'
  };
}

/**
 * Perform web search using Puppeteer with Stealth evasion, supporting pagination
 */
async function performWebSearch(query, { maxResults = 5, page = 1, timeout = 15000 } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    throw new Error('Query di ricerca non valida o vuota.');
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limit = Math.max(1, Math.min(20, parseInt(maxResults, 10) || 5));

  const browserPath = findBrowserExecutable();
  if (!puppeteerExtra || !browserPath) {
    const results = await fallbackHttpSearch(cleanQuery, limit, pageNum);
    return {
      query: cleanQuery,
      page: pageNum,
      results,
      count: results.length,
      engine: 'http-fallback'
    };
  }

  let browser = null;
  try {
    browser = await puppeteerExtra.launch({
      executablePath: browserPath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--mute-audio'
      ]
    });

    const browserPage = await browser.newPage();
    await browserPage.setViewport({ width: 1280, height: 800 });
    browserPage.setDefaultTimeout(timeout);

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
    await browserPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });

    const allItems = await browserPage.evaluate(() => {
      const items = [];
      const links = document.querySelectorAll('.result__body');
      for (const el of links) {
        if (items.length >= 50) break;
        const titleEl = el.querySelector('.result__title a');
        const snippetEl = el.querySelector('.result__snippet');
        const urlEl = el.querySelector('.result__url');
        if (titleEl) {
          let href = titleEl.getAttribute('href') || (urlEl ? urlEl.getAttribute('href') : '');
          if (href && href.includes('uddg=')) {
            try {
              const urlObj = new URL(href, window.location.origin);
              href = decodeURIComponent(urlObj.searchParams.get('uddg') || href);
            } catch {}
          }
          items.push({
            title: titleEl.textContent ? titleEl.textContent.trim() : '',
            url: href,
            snippet: snippetEl && snippetEl.textContent ? snippetEl.textContent.trim() : ''
          });
        }
      }
      return items;
    });

    const offset = Math.max(0, (pageNum - 1) * limit);
    const results = allItems.slice(offset, offset + limit);

    return {
      query: cleanQuery,
      page: pageNum,
      results,
      count: results.length,
      engine: 'puppeteer-stealth'
    };
  } catch (err) {
    console.warn('[WebSearch] Errore Puppeteer Stealth, attivazione fallback HTTP:', err.message);
    const fallbackResults = await fallbackHttpSearch(cleanQuery, limit, pageNum);
    return {
      query: cleanQuery,
      page: pageNum,
      results: fallbackResults,
      count: fallbackResults.length,
      engine: 'http-fallback',
      warning: err.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Fetch and extract clean readable content and links from a web page using Puppeteer with Stealth
 */
async function fetchPageContent(url, { maxChars = 8000, timeout = 15000 } = {}) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl || (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://'))) {
    throw new Error('URL non valido. Specificare un indirizzo web valido (http:// o https://).');
  }

  const browserPath = findBrowserExecutable();
  if (!puppeteerExtra || !browserPath) {
    return await fallbackHttpPage(cleanUrl, maxChars);
  }

  let browser = null;
  try {
    browser = await puppeteerExtra.launch({
      executablePath: browserPath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--mute-audio'
      ]
    });

    const browserPage = await browser.newPage();
    await browserPage.setViewport({ width: 1280, height: 800 });
    browserPage.setDefaultTimeout(timeout);

    await browserPage.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout });

    const data = await browserPage.evaluate((maxLen) => {
      const noisySelectors = ['script', 'style', 'noscript', 'svg', 'iframe', 'header', 'footer', 'nav', 'aside'];
      for (const sel of noisySelectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }

      const title = document.title ? document.title.trim() : '';

      const links = [];
      const seen = new Set();
      const anchors = document.querySelectorAll('a[href]');
      for (const a of anchors) {
        if (links.length >= 25) break;
        const href = a.href;
        const text = a.innerText ? a.innerText.trim() : '';
        if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !seen.has(href)) {
          seen.add(href);
          if (text) {
            links.push({ text: text.slice(0, 100), url: href });
          }
        }
      }

      const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
      const cleanText = bodyText.replace(/\s+/g, ' ').trim();

      return {
        title,
        content: cleanText.length > maxLen ? cleanText.slice(0, maxLen) + '... [contenuto troncato]' : cleanText,
        isTruncated: cleanText.length > maxLen,
        links
      };
    }, maxChars);

    return {
      url: cleanUrl,
      title: data.title,
      content: data.content,
      links: data.links,
      isTruncated: data.isTruncated,
      engine: 'puppeteer-stealth'
    };
  } catch (err) {
    console.warn('[WebBrowse] Errore Puppeteer Stealth, attivazione fallback HTTP:', err.message);
    const fallback = await fallbackHttpPage(cleanUrl, maxChars);
    fallback.warning = err.message;
    return fallback;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  performWebSearch,
  fetchPageContent,
  findBrowserExecutable
};
