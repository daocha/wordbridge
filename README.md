<img src="wordbridge-banner.png" />

# Wordbridge 字橋

English ⇄ Traditional Chinese dictionary. Installable PWA, works fully offline, desktop and mobile friendly.

- **Search** with live suggestions as you type, in English (prefix) or Chinese, Traditional or Simplified (reverse lookup: 蘋果 / 苹果 → apple)
- **Entries** show British and American IPA, each with its own play button (device speech, en-GB / en-US), Collins stars / Oxford 3000 / exam tags, Chinese senses by part of speech, word forms, English definitions, and a "Did you mean" list for typos
- **Offline**: download the whole dictionary (~364k entries, ~18 MB) into the browser in Settings. Words you look up online are cached as you go. If you remove the offline copy, the app goes back to online lookups. When you're offline and a word isn't on the device, it says so and points you to the download.
- **Install**: an Install button appears when the browser can install the app. On iOS and macOS Safari it shows step-by-step instructions. The app detects when it's already installed: running as the app, `getInstalledRelatedApps`, or the `appinstalled` event.
- **Language**: English / 繁體中文 UI, following the system language by default
- **Theme**: light / dark, following the system setting by default
- Works at `/` and under a sub-path such as `/dict/` (all URLs are relative)

Data: [ECDICT](https://github.com/skywind3000/ECDICT) (MIT), converted to Traditional Chinese with [OpenCC](https://github.com/BYVoid/OpenCC). British and American IPA come from [ipa-dict](https://github.com/open-dict-data/ipa-dict) (MIT). Its espeak-style UK stress marks are moved to the start of the syllable, and the app falls back to ECDICT's phonetic when a UK entry is missing.

## Run without Docker: `start.sh`

```sh
./start.sh              # build data if missing, start on http://0.0.0.0:8080/ (and /dict/)
PORT=9000 ./start.sh    # another port
./start.sh --rebuild    # regenerate the dictionary data first
./start.sh status
./start.sh stop
```

Each start first stops the previous instance. That is the PID saved in `.run/server.pid`, plus anything else still listening on the port, so you can re-run the script at any time. The first run creates `.venv`, installs OpenCC, downloads ECDICT and ipa-dict into `.run/` and builds `public/data`. Logs go to `.run/server.log`. It only needs Python 3 and curl.

## Run with Docker

```sh
docker compose up -d --build      # http://<ip>:8080/  and  http://<ip>:8080/dict/
```

To deploy an update, pull and **rebuild**. A plain `docker compose up -d` reuses the old image:

```sh
git pull && docker compose up -d --build
```

The image build fingerprints JS/CSS (`app.<hash>.js` via `scripts/hash_assets.py`), so browsers, the service worker and any proxy always fetch the new files. Hashed files are cached for a year as `immutable`. `index.html` and `sw.js` are always revalidated. Settings → About shows the running **App build** ID, so you can check what is deployed.

Build options (environment variables or `.env`):

| Variable        | Default    | Meaning |
|-----------------|------------|---------|
| `PORT`          | `8080`     | Host port |
| `DICT_LEVEL`    | `standard` | `core` (~60k common words), `standard` (~364k), `full` (~760k, incl. technical terms) |
| `OPENCC_CONFIG` | `s2tw`     | `s2tw` (Taiwan standard characters), `s2hk` (Hong Kong), `s2twp` (Taiwan vocabulary, e.g. 軟體), `s2t` |

The image build downloads ECDICT (~65 MB) and ipa-dict, both pinned to a commit, and generates the data, so it needs internet access.

### Hosting at https://example.com/dict/

Proxy the sub-path to the container. Either keeping or stripping the `/dict/` prefix works:

```nginx
location /dict/ {
    proxy_pass http://127.0.0.1:8080/dict/;
    proxy_set_header Host $host;
}
```

## PWA and offline notes

- The service worker (app shell offline, "Install" button) needs a **secure context**: HTTPS, or `localhost`. On plain `http://<ip>:<port>/` browsers disable service workers, but search and the offline dictionary download still work, because the data is stored in IndexedDB.
- The downloaded dictionary is versioned. After you rebuild with new data, Settings shows "Update". Until you update, the old copy stays usable offline.

### Install troubleshooting

- **Desktop Chrome / Edge** may not fire the install prompt right away: they wait for some engagement, and suppress the prompt for months after it was dismissed once. The app then shows manual steps instead. Click the install icon in the address bar, or use ⋮ → Cast, save, and share → Install page as app.
- To see why a page is not installable, open DevTools → **Application** → **Manifest** → *Installability*, and check **Service workers** to confirm `sw.js` is activated for the `/dict/` scope.
- Plain `http://<ip>:<port>` is never installable. Android's "Add to Home screen" on such a page only creates a shortcut.

## Local development

```sh
python3 -m venv .venv && .venv/bin/pip install opencc
curl -L -o ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
curl -LO https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_UK.txt
curl -LO https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_US.txt
.venv/bin/python scripts/build_dict.py --csv ecdict.csv --ipa-uk en_UK.txt --ipa-us en_US.txt --out public/data
cd public && python3 -m http.server 8000      # http://localhost:8000/
```

The front end is plain HTML/CSS/ES modules with no build step:

```
public/
  index.html, manifest.webmanifest, sw.js
  css/app.css
  js/app.js     UI, routing (#/w/<word>), settings, download
  js/data.js    shard lookup, suggestions, IndexedDB, offline download
  js/i18n.js    UI strings (en, zh-Hant)
  icons/        app icon (SVG source + PNGs)
  data/         generated by scripts/build_dict.py (not committed)
scripts/build_dict.py
scripts/hash_assets.py  fingerprints JS/CSS during the Docker build
scripts/serve.py        local static server used by start.sh
```

### Data format

`build_dict.py` sorts entries by key and packs them into ~240 range shards of 1,500 entries each (`data/s/<n>.json`). `meta.json` lists each shard's first key, so a lookup is one binary search and one file. For prefixes that span several shards (such as `c` or `co`), the build precomputes the top suggestions (`data/t/<letter>.json`). The Chinese → English index is hashed into 64 buckets (`data/r/<n>.json`). `data/s2t.json` is a Simplified → Traditional character table, built from how OpenCC converted the dictionary text. The browser uses it to convert Simplified input, and ambiguous characters such as 发 → 發/髮 are tried in every variant. Each file also gets a `.gz` copy that nginx serves with `gzip_static`.
