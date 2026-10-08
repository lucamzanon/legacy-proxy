'use strict';
/**
 * Gmail bridge labels - a Bulwark Webmail plugin.
 *
 * The Gmail bridge reports every user label through `Keyword/get`
 * (capability https://bulwarkmail.com/ns/jmap/keywords): the `$label:<id>`
 * keyword it writes on messages, the name the user gave the label in Gmail and
 * the colour Gmail shows it in. This plugin turns that answer into Bulwark tag
 * definitions as soon as an account's folders load, so a label arriving on mail
 * is named and coloured the first time it is seen instead of showing as a raw
 * id.
 *
 * Gmail keeps a hex colour; Bulwark keeps a palette key. The colour is matched
 * to the nearest palette entry by hue first, then by lightness - distance in
 * RGB reads Gmail's pale label colours as grey.
 *
 * Optionally, Gmail's inbox categories become message-list tabs. The bridge
 * does not expose categories as keywords: they are mailboxes
 * (`l_CATEGORY_SOCIAL`, ...), so each tab is a search-based tab on its
 * category's mailbox, and Primary is the default tab (everything the other
 * tabs do not match).
 *
 * Plain CommonJS with no dependencies: the file is the bundle.
 */

const LABEL_PREFIX = '$label:';
const LEGACY_LABEL_PREFIX = '$color:';
const SEPARATOR = '/';
/** keywords.add takes at most this many definitions per call. */
const MAX_ADD = 500;
/** Wait for a burst of folder refreshes (connect, account switch) to settle. */
const DEBOUNCE_MS = 2000;
/** With the folder list unchanged, ask the server again at most this often. */
const RECHECK_MS = 5 * 60 * 1000;

const DEFAULT_SETTINGS = {
  hideAdoptedTags: true,
  nestedNames: true,
  categoryTabs: false,
};

// ─── Colour matching ─────────────────────────────────────────

/** The hex behind each palette key: Tailwind 300 (light row), 500 (base), 700 (dark). */
const PALETTE_HEX = {
  red: ['#fca5a5', '#ef4444', '#b91c1c'],
  orange: ['#fdba74', '#f97316', '#c2410c'],
  amber: ['#fcd34d', '#f59e0b', '#b45309'],
  yellow: ['#fde047', '#eab308', '#a16207'],
  lime: ['#bef264', '#84cc16', '#4d7c0f'],
  green: ['#86efac', '#22c55e', '#15803d'],
  teal: ['#5eead4', '#14b8a6', '#0f766e'],
  cyan: ['#67e8f9', '#06b6d4', '#0e7490'],
  blue: ['#93c5fd', '#3b82f6', '#1d4ed8'],
  indigo: ['#a5b4fc', '#6366f1', '#4338ca'],
  purple: ['#d8b4fe', '#a855f7', '#7e22ce'],
  pink: ['#f9a8d4', '#ec4899', '#be185d'],
  gray: ['#d1d5db', '#6b7280', '#374151'],
};
/** Suffix of each row of PALETTE_HEX, in the same order. */
const ROWS = ['-light', '', '-dark'];
/** Below this saturation a colour is a shade of grey, whatever hue the arithmetic finds in it. */
const GRAY_SATURATION = 0.15;

/** `#rgb` or `#rrggbb` as hue (degrees), saturation and lightness, or null. */
function parseHsl(color) {
  if (typeof color !== 'string') return null;
  const hex = color.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const span = max - min;
  if (span === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = span / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === r ? 60 * (((g - b) / span + 6) % 6)
      : max === g ? 60 * ((b - r) / span + 2)
        : 60 * ((r - g) / span + 4);
  return { hue, saturation, lightness };
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The palette key closest to `color`, or null when it is not a hex colour -
 * the host then suggests one of its own.
 */
function nearestKeywordColor(color) {
  const target = parseHsl(color);
  if (!target) return null;

  let hue = 'gray';
  if (target.saturation >= GRAY_SATURATION) {
    let best = Infinity;
    for (const name of Object.keys(PALETTE_HEX)) {
      if (name === 'gray') continue;
      const d = hueDistance(target.hue, parseHsl(PALETTE_HEX[name][1]).hue);
      if (d < best) {
        best = d;
        hue = name;
      }
    }
  }

  let row = 1;
  let best = Infinity;
  PALETTE_HEX[hue].forEach((shade, index) => {
    const d = Math.abs(parseHsl(shade).lightness - target.lightness);
    if (d < best) {
      best = d;
      row = index;
    }
  });
  return hue + ROWS[row];
}

// ─── Tag definitions ─────────────────────────────────────────

/** `$label:clients/acme` -> `clients/acme`; null for anything that is not a tag keyword. */
function tagIdFromKeyword(keyword) {
  if (typeof keyword !== 'string') return null;
  const lower = keyword.toLowerCase();
  for (const prefix of [LABEL_PREFIX, LEGACY_LABEL_PREFIX]) {
    if (lower.startsWith(prefix)) {
      const id = keyword.slice(prefix.length);
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

/** With nesting on, ancestors name their own levels, so a tag is called by its innermost one. */
function describedLabel(name, nested) {
  const levels = String(name).split(SEPARATOR).map((level) => level.trim()).filter(Boolean);
  if (levels.length === 0) return String(name).trim();
  return nested ? levels[levels.length - 1] : levels.join(SEPARATOR);
}

/**
 * The definitions to add for the labels a server describes: one per label the
 * client cannot name yet. Existing definitions are never touched - the host's
 * keywords.add is append-only, and a tag the user already set up stays as they
 * have it.
 */
function planTags(labels, defined, options) {
  const opts = Object.assign({}, DEFAULT_SETTINGS, options);
  const known = new Set((defined || []).map((tag) => String(tag.id).toLowerCase()));
  const plan = [];
  for (const label of labels || []) {
    if (!label || !label.isProviderLabel || label.source !== 'provider') continue;
    const id = tagIdFromKeyword(label.id);
    if (!id || known.has(id.toLowerCase())) continue;
    known.add(id.toLowerCase());
    const name = describedLabel(label.name || id, opts.nestedNames) || id;
    const definition = { id, label: name.slice(0, 255) };
    const color = nearestKeywordColor(label.color);
    if (color) definition.color = color;
    if (opts.hideAdoptedTags) definition.visibility = 'hide';
    plan.push(definition);
  }
  return plan;
}

// ─── Category tabs ───────────────────────────────────────────

const CATEGORIES = [
  { id: 'social', mailbox: 'l_CATEGORY_SOCIAL', icon: 'users', order: 20 },
  { id: 'promotions', mailbox: 'l_CATEGORY_PROMOTIONS', icon: 'tag', order: 30 },
  { id: 'updates', mailbox: 'l_CATEGORY_UPDATES', icon: 'info-circle', order: 40 },
  { id: 'forums', mailbox: 'l_CATEGORY_FORUMS', icon: 'messages', order: 50 },
];

/** The server's own id of a mailbox from the host's store. */
function serverMailboxId(mailbox) {
  return mailbox.originalId || mailbox.id;
}

/**
 * Tabs for an account whose folders include Gmail's category mailboxes, or
 * null for any other account. Tabs are global in the host, so an account
 * without the categories must clear them rather than inherit the last one's.
 */
function categoryTabsConfig(mailboxes, t) {
  const present = new Set(
    (mailboxes || []).filter((mailbox) => mailbox && !mailbox.isShared).map(serverMailboxId),
  );
  const categories = CATEGORIES.filter((category) => present.has(category.mailbox));
  if (categories.length === 0) return null;
  return {
    mailboxRoles: ['inbox'],
    tabs: [
      { id: 'primary', label: t('tab.primary'), icon: 'inbox', order: 10 },
      ...categories.map((category) => ({
        id: category.id,
        label: t('tab.' + category.id),
        icon: category.icon,
        order: category.order,
        query: { inMailbox: category.mailbox },
      })),
    ],
  };
}

// ─── Runtime ─────────────────────────────────────────────────

let api = null;
let timer = null;
let pending = null;
let lastKey = null;
let lastRun = 0;
let lastTabs = undefined;

function settings() {
  const own = (api && api.plugin && api.plugin.settings) || {};
  return Object.assign({}, DEFAULT_SETTINGS, own);
}

function translate(key) {
  return api && api.i18n ? api.i18n.t(key) : key;
}

/**
 * Adopt the labels the server describes. `limit: 1` keeps this cheap where the
 * server cannot enumerate its keywords: the host then falls back to walking
 * the mailbox, and one message is enough to learn there is nothing to adopt.
 */
async function adoptLabels() {
  const result = await api.jmap.getKeywords({ limit: 1 });
  const described = (result && result.labels) || [];
  if (!described.some((label) => label.source === 'provider')) return 0;
  const defined = await api.keywords.list();
  const plan = planTags(described, defined, settings());
  let added = 0;
  for (let i = 0; i < plan.length; i += MAX_ADD) {
    const outcome = await api.keywords.add(plan.slice(i, i + MAX_ADD));
    added += outcome && outcome.added ? outcome.added.length : 0;
  }
  if (added > 0) api.log.info(`adopted ${added} label(s) as tags`);
  return added;
}

async function syncTabs(mailboxes) {
  const config = settings().categoryTabs ? categoryTabsConfig(mailboxes, translate) : null;
  const key = JSON.stringify(config);
  if (key === lastTabs) return;
  if (config) await api.tabs.set(config);
  else if (lastTabs !== undefined) await api.tabs.clear();
  lastTabs = key;
}

async function run(mailboxes) {
  if (mailboxes) {
    try {
      await syncTabs(mailboxes);
    } catch (error) {
      api.log.warn('could not set the category tabs', error);
    }
  }
  // The label set of a Gmail account is its folder set, so an unchanged folder
  // list means no new label - unless it has been a while, which also recovers
  // definitions lost to an account switch that reloaded settings mid-way.
  const key = mailboxes ? mailboxes.map(serverMailboxId).sort().join('\n') : null;
  if (key !== null && key === lastKey && Date.now() - lastRun < RECHECK_MS) return;
  try {
    await adoptLabels();
    lastKey = key;
    lastRun = Date.now();
  } catch (error) {
    // No session yet, or the server failed: the next folder refresh tries again.
    api.log.debug('could not adopt labels yet', error);
  }
}

function schedule(mailboxes) {
  pending = mailboxes;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const boxes = pending;
    pending = null;
    void run(boxes);
  }, DEBOUNCE_MS);
}

module.exports = {
  hooks: {
    /**
     * Emitted after every folder fetch: on connect, on an account switch and
     * on folder changes pushed by the server. The host awaits observers with a
     * short budget, so this only schedules the work.
     */
    onMailboxesRefresh(mailboxes) {
      if (api) schedule(Array.isArray(mailboxes) ? mailboxes : null);
    },
  },
  activate(hostApi) {
    api = hostApi;
    // Enabled while an account is already open: no folder refresh may come for
    // a while, so try once now. Without a session this fails quietly.
    schedule(null);
  },
  // Exposed for tests; the host ignores unknown exports.
  _internal: { nearestKeywordColor, tagIdFromKeyword, describedLabel, planTags, categoryTabsConfig },
};
