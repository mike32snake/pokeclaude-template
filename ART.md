# Where the art comes from

Two different things, with two different rules.

## Committed: drawn, from scratch

| | Drawn by |
|---|---|
| `public/art/buildings/*.png` | `tools/gen_buildings.py` |
| `public/art/tiles/*.png` | `tools/gen_overworld.py` |
| `public/art/trainers/variant-*.png` | `tools/gen_overworld.py` |

No source images. Both scripts draw with PIL, in the same idiom: 16px tiles, a 1px
near-black outline, three tones per surface. Re-run either one and the PNGs are
reproduced byte for byte.

    python3 tools/gen_buildings.py
    python3 tools/gen_overworld.py

Change the colours, the hat, the roof styles. If you want a different look, edit the
generator, not the PNG, so the next person can still regenerate it.

## Not committed: the creature sprites

`public/art/pokemon/` is about 18MB of Pokemon overworld sprites from the
[veekun](https://veekun.com/dex/downloads) pack. They are **not in this repo** and must
not be added to it. `tools/fetch-sprites.sh` downloads them onto your machine:

    tools/fetch-sprites.sh

Without them the field still runs; agents just do not draw. `public/art/pokemon/` and
`art-src/` are both gitignored.

## The rule

This is a localhost tool. The server binds 127.0.0.1, and it drives terminals, so
there is no reason to expose it and no auth if you do. Keep the fetched sprite pack on
your own machine, and if you want to publish a fork, publish it the way this repo is:
generators and drawn output only.

Swapping the creature sprites for art you own is a supported path. `public/js/dex.js`
maps an id to a name and `sprites.js` loads `/art/pokemon/<facing>/<id>.png`. Drop in
your own set at those paths and nothing else has to change.
