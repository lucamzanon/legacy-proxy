import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gmailFilter } from "../../src/gmail/filter.js";
import { labelKeyword } from "../../src/gmail/message.js";

const dir = fileURLToPath(new URL("../../webmail-plugin/", import.meta.url));
const code = readFileSync(dir + "index.js", "utf8");
const manifest = JSON.parse(readFileSync(dir + "manifest.json", "utf8"));

/** Evaluates the bundle the way Bulwark's sandbox runtime does: CommonJS in a function scope. */
function load() {
  const mod: { exports: any } = { exports: {} };
  const require = (name: string) => {
    throw new Error(`module ${name} is not available in the sandbox`);
  };
  new Function("module", "exports", "require", code)(mod, mod.exports, require);
  return mod.exports;
}

const PALETTE = new Set(
  ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "purple", "pink", "gray"]
    .flatMap((hue) => [hue + "-light", hue, hue + "-dark"]),
);

/** A Keyword/get entry as the bridge returns it for a Gmail user label. */
const label = (name: string, color: string | null) => ({
  id: labelKeyword(name)!,
  name,
  color,
  total: 3,
  unread: 1,
  isProviderLabel: true,
  source: "provider",
});

describe("manifest", () => {
  it("asks only for what the plugin calls", () => {
    expect(manifest.permissions.sort()).toEqual(
      ["email:read", "settings:read", "settings:write", "ui:message-list-tabs"].sort(),
    );
    expect(manifest.id).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(manifest.entrypoint).toBe("index.js");
  });

  it("passes the admin upload's dangerous-pattern scan", () => {
    for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /document\.cookie/, /document\.write/, /innerHTML\s*=/])
      expect(code).not.toMatch(pattern);
  });
});

describe("colour matching", () => {
  const { nearestKeywordColor } = load()._internal;

  it("matches a palette colour to itself and reads shorthand", () => {
    expect(nearestKeywordColor("#ef4444")).toBe("red");
    expect(nearestKeywordColor("#3b82f6")).toBe("blue");
    expect(nearestKeywordColor("#F00")).toBe(nearestKeywordColor("#ff0000"));
  });

  it("keeps Gmail's pale label colours as the light row of their hue", () => {
    expect(nearestKeywordColor("#b6cff5")).toBe("blue-light");
    expect(nearestKeywordColor("#999999")).toMatch(/^gray/);
  });

  it("always names a colour the palette has, and nothing for no colour", () => {
    for (const hex of ["#fb4c2f", "#42d692", "#b99aff", "#ffdeb5", "#ffad46", "#0b4f6c"])
      expect(PALETTE.has(nearestKeywordColor(hex))).toBe(true);
    expect(nearestKeywordColor(null)).toBeNull();
    expect(nearestKeywordColor("rebeccapurple")).toBeNull();
  });
});

describe("planning tag definitions", () => {
  const { planTags } = load()._internal;

  it("defines each label under the id the bridge writes on messages", () => {
    const plan = planTags([label("Clienti/Acmè SpA", "#b6cff5")], [], {});
    expect(plan).toEqual([
      { id: "clienti/acme-spa", label: "Acmè SpA", color: "blue-light", visibility: "hide" },
    ]);
  });

  it("keeps the full path when nesting is off, and shows the tag when asked", () => {
    const [tag] = planTags([label("Clienti/Acme", null)], [], { nestedNames: false, hideAdoptedTags: false });
    expect(tag).toEqual({ id: "clienti/acme", label: "Clienti/Acme" });
  });

  it("leaves tags that already have a definition alone, whatever their case", () => {
    const plan = planTags([label("Work", "#fb4c2f"), label("Home", null)], [{ id: "WORK", label: "Mine", color: "pink" }], {});
    expect(plan.map((t: { id: string }) => t.id)).toEqual(["home"]);
  });

  it("ignores keywords that are states or that a mailbox walk found", () => {
    const plan = planTags(
      [
        { id: "$flagged", name: "$flagged", color: null, isProviderLabel: false, source: "provider" },
        { id: "$label:x", name: "x", color: null, isProviderLabel: false, source: "message" },
      ],
      [],
      {},
    );
    expect(plan).toEqual([]);
  });
});

describe("category tabs", () => {
  const { categoryTabsConfig } = load()._internal;
  const t = (key: string) => key;

  it("offers a tab for each category mailbox the account has, Primary as the rest", () => {
    const config = categoryTabsConfig(
      [{ id: "l_INBOX", role: "inbox" }, { id: "l_CATEGORY_SOCIAL" }, { id: "l_CATEGORY_PROMOTIONS" }],
      t,
    );
    expect(config.mailboxRoles).toEqual(["inbox"]);
    expect(config.tabs.map((tab: { id: string }) => tab.id)).toEqual(["primary", "social", "promotions"]);
    expect(config.tabs[0].query).toBeUndefined();
    expect(config.tabs[2].query).toEqual({ inMailbox: "l_CATEGORY_PROMOTIONS" });
  });

  it("compiles, as the host sends it, to the Gmail search for that inbox tab", () => {
    const labels = ["INBOX", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS"].map((id) => ({ id, name: id, type: "system" }));
    const { tabs } = categoryTabsConfig(labels.map((l) => ({ id: "l_" + l.id })), t);
    const inbox = { inMailbox: "l_INBOX" };
    // The host ANDs the active tab's filter into the folder query; the default
    // tab is NOT(every other tab's filter).
    const promotions = { operator: "AND", conditions: [inbox, tabs[2].query] };
    const primary = { operator: "AND", conditions: [inbox, { operator: "NOT", conditions: [tabs[1].query, tabs[2].query] }] };
    expect(gmailFilter(promotions, labels as never)).toBe("(in:inbox) (category:promotions)");
    expect(gmailFilter(primary, labels as never)).toBe("(in:inbox) (-(category:social) -(category:promotions))");
  });

  it("offers none to an account that is not Gmail, or only shares the folders", () => {
    expect(categoryTabsConfig([{ id: "a1", role: "inbox" }], t)).toBeNull();
    expect(categoryTabsConfig([{ id: "x", originalId: "l_CATEGORY_SOCIAL", isShared: true }], t)).toBeNull();
  });
});

describe("on a folder refresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function host(labels: unknown[], settings: Record<string, unknown> = {}) {
    const defined: { id: string }[] = [];
    return {
      defined,
      plugin: { settings },
      i18n: { t: (key: string) => key },
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      jmap: { getKeywords: vi.fn(async () => ({ labels })) },
      keywords: {
        list: vi.fn(async () => defined.slice()),
        add: vi.fn(async (defs: { id: string }[]) => {
          defined.push(...defs);
          return { added: defs, skipped: [] };
        }),
      },
      tabs: { set: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
    };
  }

  it("adopts the bridge's labels once the refreshes settle, then not again for the same folders", async () => {
    const plugin = load();
    const api = host([label("Fatture", "#16a766")]);
    plugin.activate(api);
    const boxes = [{ id: "l_INBOX" }, { id: "l_Label_1" }];
    plugin.hooks.onMailboxesRefresh(boxes);
    plugin.hooks.onMailboxesRefresh(boxes);
    await vi.runAllTimersAsync();
    expect(api.jmap.getKeywords).toHaveBeenCalledTimes(1);
    expect(api.jmap.getKeywords).toHaveBeenCalledWith({ limit: 1 });
    expect(api.defined.map((t) => t.id)).toEqual(["fatture"]);

    plugin.hooks.onMailboxesRefresh(boxes);
    await vi.runAllTimersAsync();
    expect(api.jmap.getKeywords).toHaveBeenCalledTimes(1);

    plugin.hooks.onMailboxesRefresh([...boxes, { id: "l_Label_2" }]);
    await vi.runAllTimersAsync();
    expect(api.jmap.getKeywords).toHaveBeenCalledTimes(2);
  });

  it("adds nothing on a server that cannot describe its labels", async () => {
    const plugin = load();
    const api = host([{ id: "$label:work", name: "work", color: null, isProviderLabel: false, source: "message" }]);
    plugin.activate(api);
    plugin.hooks.onMailboxesRefresh([{ id: "a" }]);
    await vi.runAllTimersAsync();
    expect(api.keywords.add).not.toHaveBeenCalled();
  });

  it("sets the category tabs on a Gmail account and clears them on the next one", async () => {
    const plugin = load();
    const api = host([], { categoryTabs: true });
    plugin.activate(api);
    plugin.hooks.onMailboxesRefresh([{ id: "l_INBOX" }, { id: "l_CATEGORY_UPDATES" }]);
    await vi.runAllTimersAsync();
    expect(api.tabs.set).toHaveBeenCalledTimes(1);
    plugin.hooks.onMailboxesRefresh([{ id: "stalwart-inbox" }]);
    await vi.runAllTimersAsync();
    expect(api.tabs.clear).toHaveBeenCalledTimes(1);
  });
});
