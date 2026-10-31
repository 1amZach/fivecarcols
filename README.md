# fivecarcols

Finds and fixes siren, light and modkit id clashes between the vehicle packs on your server.

Every `carcols.meta` gives its sirens, lights and modkits a number, and the game only has so many of them. Sirens go from 1 to 254, lights from 1 to 255 and modkits from 1 to 65535 on FiveM. Pack authors pick numbers without knowing what else you run, so two packs often end up with the same one. When that happens, the one that loads last wins: sirens flash the wrong pattern, lights have the wrong colour, and tuning parts go missing at LS Customs.

The fix is giving one of them a free number and updating every place that points at it. By hand that means opening every `carcols.meta` and `carvariations.meta` you have, every time you add a pack. fivecarcols does it from the server console, shows you every change first, and keeps a backup.

## What it reads

Every resource the server knows about, wherever it is, including `[category]` folders and resources outside `resources/`. In each one it reads every `carcols.meta` and `carvariations.meta` in any subfolder, as well as renamed ones like `police_carcols.meta`. `node_modules`, `.git` and `backups` folders are skipped.

| | |
|---|---|
| `carcols.meta` | `<Sirens>`, `<Lights>` and `<Kits>` entries, by their `<id value="..."/>`. Modkits also have a `<kitName>` like `512_mypack_modkit` |
| `carvariations.meta` | `<sirenSettings value="..."/>` and `<lightSettings value="..."/>` for each car, and the kits it uses by name in `<kits>` |

Id 0 is the game's default in every pool and is never treated as a clash. Commented out entries are skipped.

## How it decides

When more than one resource uses the same id:

- Resources in `ignore` keep theirs.
- Otherwise the resource whose name comes first alphabetically keeps it, then the file path, then the order in the file. The same server always gets the same result.
- Every other one gets a new id, picked from the top of the range down. Base game sirens, lights and kits sit at the bottom, so this stays out of their way. A new id is never one that's already defined, used by any `carvariations.meta`, or in `reserved`.

A siren or light id used twice inside the same resource counts as one, so it moves together. Two modkits with the same `kitName` are the same kit shipped twice, not a clash, and move together too.

When a modkit moves, its `kitName` number changes with it (`512_mypack_modkit` becomes `65535_mypack_modkit`), and so does every `carvariations.meta` that uses that kit, in any resource. A `kitName` with no number in front keeps its name.

`sirenSettings` and `lightSettings` are just numbers, so for those it works out which entry a car means: the one in its own resource, or if its resource doesn't define that id, the one closest to it in the folder tree, like a sirens resource in the same `[police]` folder. When it can't tell, the line is left as it is and the preview says so, for you to check.

Only the numbers change. Formatting, comments, line endings and a BOM stay exactly as they were.

## Install

Drop `fivecarcols` into your resources and add to `server.cfg`:

```
ensure fivecarcols
```

## Use

Everything runs from the server console, or rcon. In-game players can't use it.

```
carcols scan           every meta file found, and each clash
carcols fix            every change a fix would make, writes nothing
carcols fix confirm    write it
carcols undo           put the last fix back
```

The preview lists each id that moves with its old and new number, and every `carvariations.meta` line that changes with it. Nothing is written until you confirm, and if any file changed since the preview it shows you the new one first. The files it changes are backed up to `backups/` before anything is touched.

After a fix, restart the server. The ids are read when a resource starts, and players already connected keep the old ones until they rejoin, so restarting just the changed resources (the confirm lists them) only helps players who join after.

`undo` puts every file back as it was before the fix, byte for byte. A file you changed after the fix is left alone and named. If the server crashed in the middle of a fix, it says so on the next start, and `undo` cleans it up.

`scan` also points out ids above the limit. With [SSLA](https://www.lcpdfr.com/downloads/dev-resources/fivem/50047-fivem-sirensetting-limit-adjuster/) installed, siren ids go up to 65534. Set `sirenMax` to match, or new siren ids will only come from 1 to 254.

## Config

`config.json`:

| | |
|---|---|
| `pools` | Which of `sirens`, `lights` and `kits` to fix. Clashes in a pool that's off are still shown |
| `sirenMax` | Highest siren id, 254, or 65534 with SSLA |
| `ignore` | Resources, or `[category]` folders, never to change. They still count when picking new ids |
| `reserved` | Ids to leave alone, per pool, like `"sirens": [1, "20-40"]`. They're never picked, and clashes on them aren't fixed |
| `backups` | Fixes to keep backups of |

## For other resources

```js
await exports.fivecarcols.scan()   // { files: [{ resource, path, ignored, defs, refs }], clashes: [{ pool, id, keeps, others }] }
await exports.fivecarcols.fix()    // { changes: [{ pool, from, to, resource, name, files, rename, refs }], warnings }
await exports.fivecarcols.apply()  // writes it: { id, files, restart, warnings }
await exports.fivecarcols.undo()   // { id, files, skipped }
```

## Support

Made by **IamZach**. Questions, bugs or ideas: [discord.gg/agn](https://discord.gg/agn)

## License

MIT
