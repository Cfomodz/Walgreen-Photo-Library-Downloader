# Walgreens Photo Library Downloader

> *"Hey, can you back up all my photos from Walgreens?"*
>
> Sure. How many?
>
> *"About eleven thousand."*
>
> ...clicking the cog icon and hitting **Download** on each one is not going to cut it.

---

## What This Is

Walgreens' photo site ([photo.walgreens.com](https://photo.walgreens.com/library/)) has no bulk-download feature. If someone asks you to rescue their photo library, you're staring down 11,000+ individual **cog -> Download** clicks.

This is a browser userscript that scans your entire Walgreens photo library and either exports a URL list for [Free Download Manager](https://www.freedownloadmanager.org/) (or any download manager) or triggers downloads directly from the browser.

No Python. No command line. No cookies to copy. Just install the script, open your photo library, and click a button.

## Usage

### 1. Install a userscript manager

Pick one:
- [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari)
- [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Edge, Firefox)

### 2. Install the userscript

Open [`walgreens-photo-downloader.user.js`](walgreens-photo-downloader.user.js) in your browser and your userscript manager will prompt you to install it. Or copy-paste the file contents into a new userscript.

### 3. Install a download manager (recommended)

[Free Download Manager](https://www.freedownloadmanager.org/) (FDM) intercepts browser downloads and handles queueing, resuming, and parallel downloads for you. Any download manager with browser integration works.

### 4. Scan and download

1. Go to [photo.walgreens.com/library/](https://photo.walgreens.com/library/) and log in
2. A **Photo Downloader** panel appears in the bottom-right corner
3. Click **Scan Library** -- the script enumerates every photo in your account
4. When the scan completes, you have three options:

| Button | What it does |
|---|---|
| **Trigger Downloads** | Batch-fires download links that FDM intercepts via its browser extension -- this is the primary method |
| **Copy URLs to Clipboard** | Copies all URLs so you can paste them into your download manager |
| **Save URL List (.txt)** | Saves a text file with one URL per line |
| **Save Details (.json)** | Saves a JSON file with URLs + original filenames + dates + MD5 hashes |

### How to use with FDM

**Method 1 -- Trigger Downloads (recommended):** Make sure FDM's browser extension is installed. Click **Trigger Downloads** and FDM will intercept each download link automatically. Configure batch size and delay to control the pace.

**Method 2 -- Copy & Paste:** Click **Copy URLs to Clipboard**, then in FDM press **Ctrl+V** or use **File > Paste URLs from Clipboard** to add them all at once.

### Trigger downloads settings

- **Batch size** -- how many downloads to fire per batch (default: 10)
- **Delay (ms)** -- pause between batches so FDM can keep up (default: 500ms)
- **Stop** button to halt mid-run

## How It Works

The userscript runs inside your authenticated browser session on `photo.walgreens.com`. It calls the same internal API the site uses:

1. Fetches an OAuth token via `/library/getOauthInfo` (your browser's cookies handle auth automatically)
2. Gets the date index from `/pict/v2/asset/dateIndex` to discover every date that has photos
3. Pages through `/pict/v2/asset/dateIndex/cluster/{date}` for each date to get full asset details
4. Extracts the full-resolution download URL from each asset's `files` array

The actual photos are served from Snapfish's CDN (`tnl.snapfish.com`). The userscript never downloads photos itself -- it just finds the URLs and hands them off to your download manager.

---

## Development

### How the API was reverse-engineered

Walgreens doesn't publish a public API for their photo library. To figure out how the site works under the hood, a [mitmproxy](https://mitmproxy.org/) capture script (`walgreens_capture.py`) was used during development to intercept and log the browser's traffic while browsing the photo library.

This is a **developer-only recon tool** -- normal users of this project never need mitmproxy or Python. It exists solely so we could discover the endpoints, auth flow, and pagination patterns that the userscript is built on.

<details>
<summary><strong>Running the capture script yourself (developers only)</strong></summary>

#### Prerequisites

| Tool | Why |
|---|---|
| **Python 3.10+** | Runtime |
| **mitmproxy** | HTTPS interception |
| A browser configured to proxy through mitmproxy | So we can see the traffic |

#### 1. Install

```bash
pip install -r requirements.txt
```

#### 2. Run the capture proxy

```bash
# Terminal UI (interactive)
mitmproxy -s walgreens_capture.py

# Browser UI at http://127.0.0.1:8081
mitmweb -s walgreens_capture.py

# Headless (just log to disk)
mitmdump -s walgreens_capture.py --quiet
```

#### 3. Trust the mitmproxy CA cert

On first run, mitmproxy generates a CA certificate. Install it so your browser doesn't reject the intercepted HTTPS traffic:

1. Navigate to [mitm.it](http://mitm.it) **while proxied**
2. Download and install the cert for your OS
3. Detailed instructions: [docs.mitmproxy.org/stable/concepts-certificates](https://docs.mitmproxy.org/stable/concepts-certificates/)

#### 4. Browse the photo library

1. Point your browser's proxy settings at `127.0.0.1:8080`
2. Go to [photo.walgreens.com/library/](https://photo.walgreens.com/library/) and log in
3. Scroll through your library -- the script captures every API call
4. When finished, check the `captures/` directory

#### 5. Review what was captured

```
captures/
├── api_log.jsonl       # Every API request/response (JSON Lines)
├── photo_urls.jsonl    # Just the image URLs with metadata
└── full/               # Raw response bodies (opt-in)
```

#### 6. Analyze the capture

```bash
python analyze_capture.py
python analyze_capture.py --json   # machine-readable output
```

</details>

## Roadmap

- [x] **Capture** -- mitmproxy script to reverse-engineer the Walgreens photo API
- [x] **Analyze** -- Document the discovered API endpoints and auth flow
- [x] **Userscript** -- Browser-native scanner + FDM export / download trigger
- [ ] **Albums** -- Support downloading by album in addition to by date
- [ ] **Videos** -- Handle video assets (currently photos only)

## License

MIT
