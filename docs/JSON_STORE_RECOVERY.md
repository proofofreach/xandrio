# JSON store recovery

`lib/json-store.js` keeps its original `load`, `save`, and `update` API for
ordinary or reconstructable state. Those calls do not create backups.

State whose loss would be costly must opt in explicitly:

```js
const store = jsonStore.createCriticalStore({
  filePath: '/data/books.json',
  defaultValue: {},
  validate: value => (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ),
  maxBackups: 5
});
```

Critical stores reject malformed JSON and values that fail their validation
hook. Before replacing an existing valid file, they retain a bounded copy in
`<store>.backups`. A restore also preserves the displaced bytes, even if those
bytes are malformed.

## Recovery drill

Stop the application before restoring a store so you inspect a stable file.
`save`/`update` take an exclusive `<store>.lock` file that serializes a CLI
and a running server. Restore still replaces the live file, so do not restore
while the server is writing.

List recovery copies and their validation status:

```sh
npm run recover:json -- list /data/books.json --type object
```

For an accounts store, also require its top-level collection:

```sh
npm run recover:json -- list /data/accounts.json --type object --required-key accounts
```

Run restore without `--yes` first. It validates and displays the selected copy
but makes no changes:

```sh
npm run recover:json -- restore /data/books.json /data/books.json.backups/CANDIDATE.json --type object
```

After reviewing the candidate, repeat with confirmation:

```sh
npm run recover:json -- restore /data/books.json /data/books.json.backups/CANDIDATE.json --type object --yes
```

Start the application and verify the recovered library. The former current
file remains in `/data/books.json.backups` for rollback. Backups contain
application data and must be protected like the primary store.
