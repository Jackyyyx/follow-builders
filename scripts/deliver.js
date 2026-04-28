#!/usr/bin/env node

// ============================================================================
// Follow Builders — Delivery Script
// ============================================================================
// Sends a digest to the user via their chosen delivery method.
// Supports: Telegram bot, Email (via Resend), or stdout (default).
//
// Usage:
//   echo "digest text" | node deliver.js
//   node deliver.js --message "digest text"
//   node deliver.js --file /path/to/digest.txt
//
//   # Cron / no-LLM mode: archive raw feed JSON to Notion
//   node prepare-digest.js | node deliver.js --raw
//
// The script reads delivery config from ~/.follow-builders/config.json
// and API keys from ~/.follow-builders/.env
//
// Delivery methods (default mode):
//   - "telegram": sends via Telegram Bot API (needs TELEGRAM_BOT_TOKEN + chat ID)
//   - "email": sends via Resend API (needs RESEND_API_KEY + email address)
//   - "stdout" (default): just prints to terminal
//
// Optional Notion archival (default mode):
//   If `config.notion.enabled` is true, every successful run also archives the
//   digest as a new page in the user's Notion database. This is independent of
//   the primary delivery method — Notion is a persistent write-only archive,
//   not a substitute for delivery. Requires NOTION_API_TOKEN in the .env file
//   and `config.notion.databaseId` in config.json.
//
// Raw mode (--raw):
//   Reads prepare-digest.js's JSON output (instead of remixed digest text),
//   dumps it as a flat Notion page (H2 sections, H3 per item, tweet bodies as
//   quote blocks, transcripts/blogs as paragraph runs). Skips telegram/email
//   primary delivery. Designed for cron deployments where Notion AI handles
//   the analysis on-demand on the user's side, so the pipeline doesn't need
//   to consume any LLM tokens.
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

// -- Read input --------------------------------------------------------------

// The digest text can come from stdin, --message flag, or --file flag
async function getDigestText() {
  const args = process.argv.slice(2);

  // Check --message flag
  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return args[msgIdx + 1];
  }

  // Check --file flag
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return await readFile(args[fileIdx + 1], 'utf-8');
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Telegram Delivery -------------------------------------------------------

// Sends the digest via Telegram Bot API.
// The user creates a bot via @BotFather and provides the token.
// The chat ID is obtained when the user sends their first message to the bot.
async function sendTelegram(text, botToken, chatId) {
  // Telegram has a 4096 character limit per message.
  // If the digest is longer, we split it into chunks.
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If Markdown parsing fails, retry without parse_mode
      if (err.description && err.description.includes("can't parse")) {
        await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
      } else {
        throw new Error(`Telegram API error: ${err.description}`);
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Notion Archival ---------------------------------------------------------

// Notion API limits per their docs:
//   - rich_text content per item: max 2000 characters
//   - children array per page-create call: max 100 blocks
// The digest is Markdown (produced by the LLM following prompts/digest-intro.md
// and friends) and we render it into native Notion blocks: heading_2 for `## `,
// heading_3 for `### `, quote for `> `, divider for `---`, paragraphs for the
// rest. Inline `[text](url)` becomes a real Notion link annotation, and
// `**bold**` becomes a bold rich_text item.
const NOTION_VERSION = '2022-06-28';
const NOTION_TEXT_LIMIT = 2000;
const NOTION_CHILDREN_LIMIT = 100;

// Splits a long string into chunks no larger than `limit` characters,
// preferring to break at the last whitespace before the limit. Used both
// for splitting block-level paragraphs (rare) and individual rich_text
// tokens that exceed the per-item content cap.
function splitForNotion(text, limit = NOTION_TEXT_LIMIT) {
  const out = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

// Converts a single inline Markdown string into an array of Notion rich_text
// items. Recognized inline patterns:
//   [text](url)  -> rich_text with text.link.url set (renders as a hyperlink)
//   **text**     -> rich_text with annotations.bold = true
// Anything else stays as plain text. Each emitted item respects the 2000-char
// content cap; if a single token is longer it gets split into multiple items
// preserving the same annotation/link.
function inlineToRichText(text) {
  if (!text) return [];

  // Tokenize first so we never split a [text](url) or **text** mid-pattern.
  // The alternation order (link before bold) matches the user's example shape
  // `（[link](url1), [link](url2)）` cleanly.
  const tokens = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) {
      tokens.push({ kind: 'plain', content: text.slice(lastIdx, m.index) });
    }
    if (m[1] != null) {
      tokens.push({ kind: 'link', content: m[1], url: m[2] });
    } else {
      tokens.push({ kind: 'bold', content: m[3] });
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    tokens.push({ kind: 'plain', content: text.slice(lastIdx) });
  }

  const out = [];
  for (const tok of tokens) {
    if (!tok.content) continue;
    const chunks = splitForNotion(tok.content);
    for (const chunk of chunks) {
      const item = { type: 'text', text: { content: chunk } };
      if (tok.kind === 'link') item.text.link = { url: tok.url };
      if (tok.kind === 'bold') item.annotations = { bold: true };
      out.push(item);
    }
  }
  return out;
}

// Turns the Markdown digest text into an array of Notion blocks.
// Mapping (line-level):
//   ## heading            -> heading_2
//   ### heading           -> heading_3
//   # heading             -> heading_1 (defensive; the new style avoids it)
//   > quote               -> quote
//   --- / *** / ___ alone -> divider
//   blank line            -> skipped (Notion's natural block spacing replaces it)
//   anything else         -> paragraph
// Each block's text content goes through inlineToRichText so [text](url) and
// **bold** render as real Notion annotations rather than literal characters.
function digestToNotionBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') continue;

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      continue;
    }

    if (line.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: inlineToRichText(line.slice(4)) }
      });
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: inlineToRichText(line.slice(3)) }
      });
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: inlineToRichText(line.slice(2)) }
      });
      continue;
    }
    if (line.startsWith('> ')) {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: inlineToRichText(line.slice(2)) }
      });
      continue;
    }

    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: inlineToRichText(line) }
    });
  }

  return blocks;
}

// Returns the local YYYY-MM-DD date in the given IANA timezone (or system tz).
function todayInTimezone(timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return fmt.format(new Date()); // en-CA renders as YYYY-MM-DD
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Calls the Notion API and throws a useful error on non-2xx responses.
async function notionFetch(path, token, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Notion API ${res.status}: ${errBody.slice(0, 500)}`);
  }
  return res.json();
}

// Inspects the database schema to find the title property and a "Type"-like
// select property. Notion property names are user-defined, so we discover
// them dynamically rather than hardcoding "Name" / "Type".
async function resolveNotionSchema(databaseId, token) {
  const db = await notionFetch(`/databases/${databaseId}`, token);
  const props = db.properties || {};

  let titleProp = null;
  let typeProp = null;
  let typePropKind = null; // 'select' or 'multi_select'

  for (const [name, def] of Object.entries(props)) {
    if (def.type === 'title' && !titleProp) {
      titleProp = name;
    }
    if (!typeProp && (def.type === 'select' || def.type === 'multi_select')) {
      // Prefer a property literally named Type / 类型 / 类别 / Category
      const lower = name.toLowerCase();
      if (lower === 'type' || name === '类型' || name === '类别' || lower === 'category') {
        typeProp = name;
        typePropKind = def.type;
      }
    }
  }

  // Fallback: if no obvious "Type" property was found, take the first
  // select/multi_select property in the database (still safer than hardcoding).
  if (!typeProp) {
    for (const [name, def] of Object.entries(props)) {
      if (def.type === 'select' || def.type === 'multi_select') {
        typeProp = name;
        typePropKind = def.type;
        break;
      }
    }
  }

  if (!titleProp) {
    throw new Error('Could not find a title property on the Notion database');
  }

  return { titleProp, typeProp, typePropKind };
}

// Archives a pre-built array of Notion blocks as a new page in the user's
// database. Handles schema discovery, properties, and the 100-children
// per-request batching. Both text-mode (digestToNotionBlocks) and raw-mode
// (buildRawNotionBlocks) call into this.
async function archiveBlocksToNotion(blocks, token, notionConfig, userTimezone) {
  const databaseId = notionConfig.databaseId;
  if (!databaseId) throw new Error('notion.databaseId not found in config.json');

  const { titleProp, typeProp, typePropKind } =
    await resolveNotionSchema(databaseId, token);

  const dateStr = todayInTimezone(userTimezone);
  const titleText = (notionConfig.titlePrefix || 'AI Builders Digest — ') + dateStr;
  const typeValue = notionConfig.type || 'RSS';

  const properties = {
    [titleProp]: {
      title: [{ type: 'text', text: { content: titleText } }]
    }
  };

  if (typeProp) {
    properties[typeProp] = typePropKind === 'multi_select'
      ? { multi_select: [{ name: typeValue }] }
      : { select: { name: typeValue } };
  }

  const firstBatch = blocks.slice(0, NOTION_CHILDREN_LIMIT);
  const rest = blocks.slice(NOTION_CHILDREN_LIMIT);

  const page = await notionFetch('/pages', token, {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children: firstBatch
    })
  });

  // If the page has more than 100 blocks, append the rest in batches.
  for (let i = 0; i < rest.length; i += NOTION_CHILDREN_LIMIT) {
    const batch = rest.slice(i, i + NOTION_CHILDREN_LIMIT);
    await notionFetch(`/blocks/${page.id}/children`, token, {
      method: 'PATCH',
      body: JSON.stringify({ children: batch })
    });
  }

  return { pageId: page.id, url: page.url, title: titleText };
}

// Archives a remixed Markdown digest (the LLM's output) to Notion.
// Title is "AI Builders Digest — YYYY-MM-DD" in the user's timezone.
async function sendNotion(text, token, notionConfig, userTimezone) {
  const blocks = digestToNotionBlocks(text);
  return archiveBlocksToNotion(blocks, token, notionConfig, userTimezone);
}

// -- Raw-mode Notion blocks --------------------------------------------------

// Wraps a (possibly long) plain string in a single paragraph block, splitting
// the content across multiple rich_text items so each item respects the
// 2000-char per-item cap. Plain text only — no Markdown parsing — so tweet
// content with literal `[]()` characters renders verbatim.
function paragraphPlain(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: splitForNotion(text || '').map(c => ({
        type: 'text',
        text: { content: c }
      }))
    }
  };
}

// Same as paragraphPlain but emits a quote block. Used for tweet bodies so
// they're visually distinct from the surrounding metadata.
function quotePlain(text) {
  return {
    object: 'block',
    type: 'quote',
    quote: {
      rich_text: splitForNotion(text || '').map(c => ({
        type: 'text',
        text: { content: c }
      }))
    }
  };
}

// Splits a long block of text (transcript, blog body) into individual
// paragraph blocks, breaking at natural paragraph boundaries first and
// then chunking any overlong piece at the 2000-char cap.
function plainTextToParagraphBlocks(text) {
  const out = [];
  if (!text) return out;
  for (const part of text.split(/\n\n+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    out.push(paragraphPlain(trimmed));
  }
  return out;
}

// Builds the Notion block list for `--raw` mode: a flat archive of the
// prepare-digest.js output, no LLM remix, no embedded prompts, no fancy
// formatting. The shape:
//
//   ## X / Twitter
//   ### {Name} (@{handle})
//   bio: ...
//   <quote>tweet text</quote>
//   [link](url) · timestamp
//   <quote>...</quote>
//   ...
//   ---
//   ## 播客
//   ### {PodcastName} — {Title}
//   [link](url) · published: ...
//   <transcript paragraph 1>
//   <transcript paragraph 2>
//   ...
//   ---
//   ## 博客
//   ### {BlogName} — {Title}
//   [link](url) · author: ... · published: ...
//   <content paragraph 1>
//   ...
//
// Notion AI runs on this page on demand to produce the formatted digest;
// we only have to make the source data legible, not pretty.
function buildRawNotionBlocks(data) {
  const blocks = [];

  const h2 = (text) => ({
    object: 'block', type: 'heading_2',
    heading_2: { rich_text: inlineToRichText(text) }
  });
  const h3 = (text) => ({
    object: 'block', type: 'heading_3',
    heading_3: { rich_text: inlineToRichText(text) }
  });
  const divider = () => ({ object: 'block', type: 'divider', divider: {} });
  const inlinePara = (text) => ({
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: inlineToRichText(text) }
  });

  // X / Twitter
  if (data.x && data.x.length > 0) {
    blocks.push(h2('X / Twitter'));
    for (const builder of data.x) {
      const handle = builder.handle ? ` (@${builder.handle})` : '';
      blocks.push(h3(`${builder.name}${handle}`));
      if (builder.bio) {
        blocks.push(paragraphPlain(`bio: ${builder.bio.replace(/\s+/g, ' ').trim()}`));
      }
      for (const tweet of (builder.tweets || [])) {
        blocks.push(quotePlain(tweet.text || ''));
        const metaParts = [];
        if (tweet.url) metaParts.push(`[link](${tweet.url})`);
        if (tweet.createdAt) metaParts.push(tweet.createdAt);
        if (metaParts.length > 0) blocks.push(inlinePara(metaParts.join(' · ')));
      }
    }
    blocks.push(divider());
  }

  // Podcasts
  if (data.podcasts && data.podcasts.length > 0) {
    blocks.push(h2('播客'));
    for (const ep of data.podcasts) {
      blocks.push(h3(`${ep.name} — ${ep.title}`));
      const metaParts = [];
      if (ep.url) metaParts.push(`[link](${ep.url})`);
      if (ep.publishedAt) metaParts.push(`published: ${ep.publishedAt}`);
      if (metaParts.length > 0) blocks.push(inlinePara(metaParts.join(' · ')));
      for (const para of plainTextToParagraphBlocks(ep.transcript || '')) {
        blocks.push(para);
      }
    }
    blocks.push(divider());
  }

  // Blogs
  if (data.blogs && data.blogs.length > 0) {
    blocks.push(h2('博客'));
    for (const post of data.blogs) {
      blocks.push(h3(`${post.name} — ${post.title}`));
      const metaParts = [];
      if (post.url) metaParts.push(`[link](${post.url})`);
      if (post.author) metaParts.push(`author: ${post.author}`);
      if (post.publishedAt) metaParts.push(`published: ${post.publishedAt}`);
      if (metaParts.length > 0) blocks.push(inlinePara(metaParts.join(' · ')));
      for (const para of plainTextToParagraphBlocks(post.content || '')) {
        blocks.push(para);
      }
    }
  }

  // Trim a trailing divider, if any (cleaner ending when only one section ran).
  while (blocks.length > 0 && blocks[blocks.length - 1].type === 'divider') {
    blocks.pop();
  }

  return blocks;
}

// -- Email Delivery (Resend) -------------------------------------------------

// Sends the digest via Resend's email API.
// The user provides their own Resend API key and email address.
async function sendEmail(text, apiKey, toEmail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [toEmail],
      subject: `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Load env and config
  loadEnv({ path: ENV_PATH });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const args = process.argv.slice(2);
  const isRaw = args.includes('--raw');

  // -- Raw mode: archive prepare-digest.js's JSON straight to Notion --------
  // Used for cron deployments that don't run an LLM in-process. Notion AI on
  // the user's side is expected to do the analysis. Telegram/email/stdout
  // primary delivery is skipped because the raw payload is structured data,
  // not something useful to push through those channels.
  if (isRaw) {
    const rawInput = await getDigestText();
    if (!rawInput || !rawInput.trim()) {
      console.error(JSON.stringify({
        status: 'error',
        message: '--raw expects JSON from prepare-digest.js on stdin or via --file'
      }));
      process.exit(1);
    }

    let prepData;
    try {
      prepData = JSON.parse(rawInput);
    } catch {
      console.error(JSON.stringify({
        status: 'error',
        message: '--raw input is not valid JSON; pipe prepare-digest.js into deliver.js'
      }));
      process.exit(1);
    }

    if (!config.notion || !config.notion.enabled) {
      console.error(JSON.stringify({
        status: 'error',
        message: '--raw requires config.notion.enabled = true in config.json'
      }));
      process.exit(1);
    }

    const token = process.env.NOTION_API_TOKEN || config.notion.token;
    if (!token) {
      console.error(JSON.stringify({
        status: 'error',
        message: 'NOTION_API_TOKEN not set in environment or config.notion.token'
      }));
      process.exit(1);
    }

    const blocks = buildRawNotionBlocks(prepData);

    if (blocks.length === 0) {
      console.error(JSON.stringify({
        status: 'skipped',
        reason: 'No content in feeds (empty x / podcasts / blogs)',
        stats: prepData.stats || {}
      }));
      return;
    }

    try {
      const archived = await archiveBlocksToNotion(blocks, token, config.notion, config.timezone);
      console.log(JSON.stringify({
        status: 'ok',
        method: 'notion-raw',
        title: archived.title,
        url: archived.url,
        blockCount: blocks.length,
        stats: prepData.stats || {}
      }));
    } catch (err) {
      console.error(JSON.stringify({
        status: 'error',
        method: 'notion-raw',
        message: err.message
      }));
      process.exit(1);
    }
    return;
  }

  // -- Default mode: remixed digest text -----------------------------------

  const delivery = config.delivery || { method: 'stdout' };
  const digestText = await getDigestText();

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
    return;
  }

  // Track outcomes so a failure in one delivery channel doesn't silently
  // swallow the others. The primary method (telegram/email/stdout) runs first,
  // then we always attempt Notion archival if it's enabled.
  const results = [];
  let primaryFailed = false;

  try {
    switch (delivery.method) {
      case 'telegram': {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = delivery.chatId;
        if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
        if (!chatId) throw new Error('delivery.chatId not found in config.json');
        await sendTelegram(digestText, botToken, chatId);
        results.push({ method: 'telegram', status: 'ok', message: 'Digest sent to Telegram' });
        break;
      }

      case 'email': {
        const apiKey = process.env.RESEND_API_KEY;
        const toEmail = delivery.email;
        if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
        if (!toEmail) throw new Error('delivery.email not found in config.json');
        await sendEmail(digestText, apiKey, toEmail);
        results.push({ method: 'email', status: 'ok', message: `Digest sent to ${toEmail}` });
        break;
      }

      case 'stdout':
      default:
        // Just print to terminal — the agent or OpenClaw handles delivery.
        // Stdout delivery is intentionally silent on the results channel
        // because the digest text itself is the output.
        console.log(digestText);
        break;
    }
  } catch (err) {
    primaryFailed = true;
    results.push({ method: delivery.method, status: 'error', message: err.message });
  }

  // Optional Notion archival — runs in addition to the primary delivery.
  // Failures here are reported but do not fail the whole run, since the
  // digest may have already been delivered to the user via the primary path.
  if (config.notion && config.notion.enabled) {
    try {
      const token = process.env.NOTION_API_TOKEN || config.notion.token;
      if (!token) throw new Error('NOTION_API_TOKEN not found in .env or config.notion.token');
      const archived = await sendNotion(digestText, token, config.notion, config.timezone);
      results.push({
        method: 'notion',
        status: 'ok',
        message: `Archived to Notion: ${archived.title}`,
        url: archived.url
      });
    } catch (err) {
      results.push({ method: 'notion', status: 'error', message: err.message });
    }
  }

  if (results.length > 0) {
    // Use stderr for status reports when stdout was used to print the digest,
    // so callers piping the digest don't get JSON appended.
    const out = delivery.method === 'stdout' ? console.error : console.log;
    out(JSON.stringify(results.length === 1 ? results[0] : { results }));
  }

  if (primaryFailed) process.exit(1);
}

main();
