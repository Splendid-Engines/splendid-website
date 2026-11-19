#!/usr/bin/env node
// build-feeds.mjs - write the writing RSS feed and the site map.
//
//   node scripts/build-feeds.mjs      (or: npm run feeds:build)
//
// The site has no build step at deploy: Cloudflare serves public/ as is. So the
// two generated files are committed, and this script regenerates them:
//
//   public/writing/feed.xml   RSS 2.0, one item per article, newest first.
//   public/sitemap.xml        every public page, with <lastmod> for articles.
//
// An article is public/writing/<slug>/index.html. Each one must carry
//   <meta property="article:published_time" content="YYYY-MM-DD" />
// in its <head>; the script stops with an error when an article lacks it.
//
// Skipped everywhere: folders whose name starts with "_" or "." (_template,
// _includes), "[slug]"-style placeholder folders, draft folders, and pages
// marked <meta name="robots" content="noindex">.
//
// Deterministic: no clock, no git. The same files in give the same bytes out,
// so a rerun with no content change leaves git clean. The feeds GitHub Action
// (.github/workflows/feeds.yml) fails when the committed files are stale.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://splendidengines.com';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const WRITING = path.join(PUBLIC, 'writing');
const FEED_PATH = path.join(WRITING, 'feed.xml');
const SITEMAP_PATH = path.join(PUBLIC, 'sitemap.xml');

const FEED_TITLE = 'Splendid Engines: Writing';
const FEED_LINK = `${SITE}/writing/`;
const FEED_DESCRIPTION = 'Considered essays and reports from Splendid Engines.';

// ---------------------------------------------------------------- helpers

function isSkippedDir(name) {
  return (
    name.startsWith('_') ||
    name.startsWith('.') ||
    /[\[\]]/.test(name) ||
    /^drafts?$/i.test(name) ||
    name === 'node_modules'
  );
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  copy: '©', reg: '®', trade: '™', eacute: 'é',
  rarr: '→', larr: '←', times: '×', bull: '•',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function headOf(html) {
  const m = html.match(/<head[\s>][\s\S]*?<\/head>/i);
  // Drop HTML comments so commented-out examples are never read as metadata.
  return (m ? m[0] : html).replace(/<!--[\s\S]*?-->/g, '');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]) : null;
}

// Content of the first <meta> whose `key` attribute (property or name) is `value`.
function meta(head, key, value) {
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    if ((attr(tag, key) || '').toLowerCase() === value.toLowerCase()) {
      const c = attr(tag, 'content');
      if (c !== null) return decodeEntities(c).trim();
    }
  }
  return null;
}

function canonicalLink(head) {
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    if ((attr(tag, 'rel') || '').toLowerCase().split(/\s+/).includes('canonical')) {
      const h = attr(tag, 'href');
      if (h) return decodeEntities(h).trim();
    }
  }
  return null;
}

function isNoindex(head) {
  const robots = meta(head, 'name', 'robots');
  return !!robots && /noindex/i.test(robots);
}

// Accepts YYYY-MM-DD or a full ISO 8601 date-time. Returns a Date or null.
function parsePublished(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

function rfc822(d) {
  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

// ------------------------------------------------------------- articles

function readArticles() {
  const articles = [];
  const errors = [];
  const slugs = fs
    .readdirSync(WRITING, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isSkippedDir(e.name))
    .map((e) => e.name)
    .sort();

  for (const slug of slugs) {
    const file = path.join(WRITING, slug, 'index.html');
    if (!fs.existsSync(file)) continue;
    const head = headOf(fs.readFileSync(file, 'utf8'));
    if (isNoindex(head)) continue;

    const rel = path.relative(ROOT, file);
    let title = meta(head, 'property', 'og:title');
    if (!title) {
      const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = t ? decodeEntities(t[1]).replace(/\s*[-–|]\s*Splendid Engines\s*$/i, '').trim() : '';
    }
    const link =
      canonicalLink(head) || meta(head, 'property', 'og:url') || `${SITE}/writing/${slug}/`;
    const description =
      meta(head, 'property', 'og:description') || meta(head, 'name', 'description') || '';
    const publishedRaw = meta(head, 'property', 'article:published_time');
    const published = parsePublished(publishedRaw);

    if (!title) errors.push(`${rel}: no og:title or <title>`);
    if (!publishedRaw) {
      errors.push(`${rel}: missing <meta property="article:published_time" content="YYYY-MM-DD" />`);
    } else if (!published) {
      errors.push(`${rel}: article:published_time "${publishedRaw}" is not an ISO 8601 date`);
    }
    if (/[\[\]]/.test(link) || /[\[\]]/.test(title)) {
      errors.push(`${rel}: still has a [placeholder] in its title or URL`);
    }

    articles.push({ slug, title, link, description, publishedRaw, published });
  }

  if (errors.length) {
    console.error('build-feeds: fix these articles first:\n  ' + errors.join('\n  '));
    process.exit(1);
  }

  // Newest first; the slug breaks ties so the order never depends on the file system.
  articles.sort((a, b) => b.published - a.published || a.slug.localeCompare(b.slug));
  return articles;
}

// ------------------------------------------------------------------ feed

function buildFeed(articles) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape(FEED_TITLE)}</title>`,
    `    <link>${xmlEscape(FEED_LINK)}</link>`,
    `    <description>${xmlEscape(FEED_DESCRIPTION)}</description>`,
    '    <language>en</language>',
    `    <atom:link href="${xmlEscape(`${SITE}/writing/feed.xml`)}" rel="self" type="application/rss+xml" />`,
  ];
  if (articles.length) lines.push(`    <lastBuildDate>${rfc822(articles[0].published)}</lastBuildDate>`);
  for (const a of articles) {
    lines.push(
      '    <item>',
      `      <title>${xmlEscape(a.title)}</title>`,
      `      <link>${xmlEscape(a.link)}</link>`,
      `      <guid isPermaLink="true">${xmlEscape(a.link)}</guid>`,
      `      <pubDate>${rfc822(a.published)}</pubDate>`,
      `      <description>${xmlEscape(a.description)}</description>`,
      '    </item>',
    );
  }
  lines.push('  </channel>', '</rss>', '');
  return lines.join('\n');
}

// --------------------------------------------------------------- sitemap

function collectPages(dir, urlPath, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const index = path.join(dir, 'index.html');
  if (fs.existsSync(index)) {
    const head = headOf(fs.readFileSync(index, 'utf8'));
    if (!isNoindex(head)) out.push(urlPath);
  }
  for (const e of entries) {
    if (e.isDirectory() && !isSkippedDir(e.name)) {
      collectPages(path.join(dir, e.name), `${urlPath}${e.name}/`, out);
    }
  }
  return out;
}

function buildSitemap(articles) {
  const lastmod = new Map(articles.map((a) => [`/writing/${a.slug}/`, a.publishedRaw.slice(0, 10)]));
  const pages = collectPages(PUBLIC, '/', []).sort();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const p of pages) {
    lines.push('  <url>', `    <loc>${xmlEscape(SITE + p)}</loc>`);
    if (lastmod.has(p)) lines.push(`    <lastmod>${lastmod.get(p)}</lastmod>`);
    lines.push('  </url>');
  }
  lines.push('</urlset>', '');
  return { xml: lines.join('\n'), count: pages.length };
}

// ------------------------------------------------------------------ main

function writeIfChanged(file, content) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

const articles = readArticles();
const feed = buildFeed(articles);
const sitemap = buildSitemap(articles);
const feedChanged = writeIfChanged(FEED_PATH, feed);
const sitemapChanged = writeIfChanged(SITEMAP_PATH, sitemap.xml);

console.log(
  `build-feeds: ${articles.length} articles -> ${path.relative(ROOT, FEED_PATH)} (${feedChanged ? 'updated' : 'unchanged'}); ` +
    `${sitemap.count} pages -> ${path.relative(ROOT, SITEMAP_PATH)} (${sitemapChanged ? 'updated' : 'unchanged'})`,
);
