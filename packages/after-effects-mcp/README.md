# After Effects MCP server

Pins one release of the After Effects MCP server (`jefao-ai/ae-mcp-tuift`, MIT) that Motion chats
attach. `server.json` is the manifest; `scripts/sync.js` builds `bundle/` from it (gitignored), and
the installer copies `bundle/after-effects-mcp/` to `resources/after-effects-mcp`, outside the asar.

## Pinning a release (the only edit needed)

While `"pinned": false`, `sync` does nothing, `--verify` passes and the installer carries no server:
the app behaves as it did without this package. After the release is published, set these fields in
`server.json` and nothing else:

| Field     | Value                                                                       |
| --------- | --------------------------------------------------------------------------- |
| `pinned`  | `true`                                                                      |
| `version` | the release version, e.g. `1.0.0`                                           |
| `tag`     | the release tag, e.g. `v1.0.0`                                              |
| `commit`  | the full 40-character commit of the tag                                     |
| `asset`   | `after-effects-mcp-<version>.tgz`                                           |
| `url`     | `https://github.com/jefao-ai/ae-mcp-tuift/releases/download/<tag>/<asset>` |
| `sha256`  | SHA-256 of the `.tgz` (64 hex characters)                                   |
| `bytes`   | size of the `.tgz` in bytes                                                 |

`repository` and `license` stay. A half-filled manifest (a pin field set while `pinned` is false, or
a malformed value, or a `url` that is not the one above) fails `sync`, `--verify` and the release checks.

## What sync does

```
node scripts/sync.js            fetch when the bundle is missing or differs
node scripts/sync.js --verify   check the bundle on disk against server.json; no network
```

- The download must match `bytes` and `sha256`, or nothing is unpacked.
- The `.tgz` holds one top-level folder, `after-effects-mcp/`. Every entry must be a regular file
  below it: no links, no `..`, absolute, drive or backslash paths, no second top-level entry, no paths
  that differ only in case. It must contain `dist/index.js`, `jsx/`, `package.json`, `LICENSE`,
  `NOTICE.md` and `THIRD_PARTY_LICENSES.txt`.
- The bundle is built next to the old one and swapped in only when all of that held. `receipt.json`
  beside the server folder records the release and a digest of its files; `--verify`, the licence
  gate and the installer proof compare against it.
- `TUIFT_AE_MCP_TARBALL=<file>` stands in for the download (development, tests); the size and SHA-256
  checks still apply, so a local tarball needs a local, pinned `server.json` that describes it.
- Not pinned: a bundle left over from an earlier pin is removed, so a build cannot ship it.

## Running from source

An unpackaged run finds `bundle/after-effects-mcp/dist/index.js` after `sync`. `TUIFT_AE_MCP_DIR`
(a folder with `dist/index.js`) still wins over it.
