# Gmail bridge labels (Bulwark Webmail plugin)

A Bulwark Webmail plugin for accounts served by this bridge's Gmail backend.

- **Labels become tags.** When an account's folders load, the plugin asks the
  server for its labels (`Keyword/get`, capability
  `https://bulwarkmail.com/ns/jmap/keywords`) and defines a Bulwark tag for
  every label that has none yet: the `$label:<id>` keyword the bridge writes on
  messages, the name from Gmail, and Gmail's colour matched to the nearest
  colour of Bulwark's tag palette. Tags that already exist are never changed.
- **Inbox categories as tabs** (off by default). Gmail's Social, Promotions,
  Updates and Forums become tabs above the inbox, with Primary for the rest.
  The bridge exposes categories as mailboxes (`l_CATEGORY_*`), not keywords, so
  these are search tabs: nothing is written to messages, and moving a message
  between tabs is not supported.

On accounts that are not Gmail the plugin does nothing: the label probe reads
one message at most, and the category tabs are cleared.

## Permissions

| Permission | Used for |
| --- | --- |
| `email:read` | `jmap.getKeywords`, the `onMailboxesRefresh` hook |
| `settings:read` | `keywords.list`, to skip tags that already exist |
| `settings:write` | `keywords.add`, to define the missing ones |
| `ui:message-list-tabs` | `tabs.set` / `tabs.clear` for the category tabs |

## Install

The bundle is `index.js` as it is; there is no build step.

**As an admin-managed plugin** (what users on the instance get):

```sh
cd webmail-plugin
zip bridge-labels-0.1.0.zip manifest.json index.js
```

Only `manifest.json` and `index.js` go in the ZIP: the upload refuses file
types it does not know, `.md` included. Then, in Bulwark, *Admin → Plugins →
Upload* the ZIP and enable it (or force-enable it for everyone). Admin-uploaded
plugins need no separate approval or signing step; the server signs the bundle
it serves. Each user can change the plugin's options under
*Settings → Plugins*.

**In development**, point `PLUGIN_DEV_DIR` at a directory containing a copy of
this one named `bridge-labels/`; the bundle is re-read on every page load.

## Options

- *Keep adopted labels out of the Tags list* (on): every label is already a
  folder, so the tag only names and colours the label on messages.
- *Name nested labels by their last level* (on): match it to Bulwark's nested
  tags setting, which plugins cannot read.
- *Show Gmail's inbox categories as tabs* (off).

## Limits

- Only the account on screen is handled: the plugin API reaches the active
  account only, and tag definitions belong to the active account's settings. A
  connected account's labels are adopted the first time it is opened.
- A label renamed or recoloured in Gmail keeps its old tag: the host's
  `keywords.add` only appends.

## Tests

`npx vitest run test/unit/webmail-plugin.spec.ts` evaluates the bundle the way
Bulwark's sandbox does and checks it against the bridge's own label keywords
and search translation.
