// ==UserScript==
// @name         Walgreens Photo Library Downloader
// @namespace    https://github.com/walgreens-photo-downloader
// @version      1.0.0
// @description  Bulk-download your entire Walgreens photo library. Scans the library API, then exports URLs for Free Download Manager (or triggers downloads directly).
// @match        https://photo.walgreens.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ── API ─────────────────────────────────────────────────────────

  const OAUTH_URL = "/library/getOauthInfo";
  const DATE_INDEX_URL = "/pict/v2/asset/dateIndex";
  const CLUSTER_URL = "/pict/v2/asset/dateIndex/cluster";

  function generateNoodle() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  async function getOAuthInfo() {
    const params = new URLSearchParams({
      website: "walgreens_us",
      cobrand: "walgreens",
      locale: "en_US",
    });
    const resp = await fetch(`${OAUTH_URL}?${params}`, {
      credentials: "include",
    });
    if (!resp.ok) throw new Error(`getOauthInfo failed: ${resp.status}`);
    const data = await resp.json();
    const oauth = data.oauthInfo;
    if (!oauth || !oauth.oa2) {
      throw new Error(
        "Failed to get OAuth token. Are you logged in?\n" +
          JSON.stringify(data).slice(0, 300)
      );
    }
    return {
      gsid: oauth.GSID,
      token: oauth.oa2,
      accountId: oauth.accountId,
      dc: oauth.dc,
      refreshTime: parseInt(oauth.refreshTime, 10) || 3600,
      noodle: generateNoodle(),
      obtainedAt: Date.now(),
    };
  }

  function apiHeaders(auth) {
    return {
      authorization: `OAuth ${auth.token}`,
      access_token: `OAuth ${auth.token}`,
      gsid: auth.gsid,
      noodle: auth.noodle,
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/json",
    };
  }

  function isTokenExpired(auth) {
    const elapsed = (Date.now() - auth.obtainedAt) / 1000;
    return elapsed >= auth.refreshTime - 300;
  }

  async function getDateIndex(auth) {
    const params = new URLSearchParams({
      limit: "0",
      minAsset: "0",
      sortCriteria: "createDate",
      timezoneOffset: String(new Date().getTimezoneOffset()),
      bn: "mozilla",
      os: "win",
    });
    const resp = await fetch(`${DATE_INDEX_URL}?${params}`, {
      credentials: "include",
      headers: apiHeaders(auth),
    });
    if (!resp.ok) throw new Error(`dateIndex failed: ${resp.status}`);
    const data = await resp.json();
    const dateMap = {};
    for (const [date, info] of Object.entries(data.entityMap || {})) {
      const count = parseInt(info.assetCount, 10) || 0;
      if (count > 0) dateMap[date] = count;
    }
    return dateMap;
  }

  async function getAssetsForDate(auth, date, total) {
    const PAGE_SIZE = 100;
    const assets = [];
    let skip = 0;

    while (skip < total) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        skip: String(skip),
        date: "createDate",
        timezoneOffset: String(new Date().getTimezoneOffset()),
        bn: "mozilla",
        os: "win",
      });
      const resp = await fetch(`${CLUSTER_URL}/${date}?${params}`, {
        credentials: "include",
        headers: apiHeaders(auth),
      });
      if (!resp.ok) throw new Error(`cluster ${date} failed: ${resp.status}`);
      const data = await resp.json();
      const entities = data.entities || [];
      if (entities.length === 0) break;

      for (const entity of entities) {
        const asset = parseAsset(entity, date);
        if (asset) assets.push(asset);
      }
      skip += PAGE_SIZE;
    }
    return assets;
  }

  function parseAsset(entity, date) {
    let hiresUrl = null;
    let size = 0;
    for (const f of entity.files || []) {
      if (f.fileType === "HIRES" && f.url) {
        hiresUrl = f.url;
        size = f.size || 0;
        break;
      }
    }
    if (!hiresUrl) return null;

    const tags = {};
    for (const t of entity.userTags || []) {
      if (t.key) tags[t.key] = t.value;
    }

    const filename =
      tags.userFileName || tags.caption || `${entity._id || "unknown"}.jpg`;
    const info = entity.currentImageInfo || {};

    return {
      id: entity._id,
      date,
      filename,
      url: hiresUrl,
      md5: entity.md5sum || null,
      size,
      width: info.currentWidth || 0,
      height: info.currentHeight || 0,
      subType: entity.subType || "",
    };
  }

  // ── UI ──────────────────────────────────────────────────────────

  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "wag-dl-panel";
    panel.innerHTML = `
      <div id="wag-dl-header">
        <span id="wag-dl-title">Photo Downloader</span>
        <button id="wag-dl-minimize" title="Minimize">_</button>
      </div>
      <div id="wag-dl-body">
        <div id="wag-dl-status">Ready. Click Scan to enumerate your library.</div>
        <div id="wag-dl-progress-wrap">
          <div id="wag-dl-progress-bar"></div>
        </div>
        <div id="wag-dl-counts"></div>
        <div id="wag-dl-actions">
          <button id="wag-dl-scan" class="wag-btn wag-btn-primary">Scan Library</button>
        </div>
        <div id="wag-dl-export-actions" style="display:none;">
          <div id="wag-dl-section-label">Download via FDM (recommended)</div>
          <label>
            Batch size
            <input id="wag-dl-batch" type="number" value="10" min="1" max="100">
          </label>
          <label>
            Delay (ms)
            <input id="wag-dl-delay" type="number" value="500" min="0" max="10000" step="100">
          </label>
          <button id="wag-dl-trigger" class="wag-btn wag-btn-primary">Trigger Downloads</button>
          <button id="wag-dl-stop" class="wag-btn wag-btn-danger" style="display:none;">Stop</button>
          <hr>
          <div id="wag-dl-section-label">Export</div>
          <button id="wag-dl-copy-urls" class="wag-btn">Copy URLs to Clipboard</button>
          <button id="wag-dl-export-txt" class="wag-btn">Save URL List (.txt)</button>
          <button id="wag-dl-export-json" class="wag-btn">Save Details (.json)</button>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #wag-dl-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 340px;
        background: #1a1a2e;
        color: #e0e0e0;
        border-radius: 10px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.4);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        z-index: 999999;
        overflow: hidden;
        transition: all 0.2s ease;
      }
      #wag-dl-panel.minimized #wag-dl-body { display: none; }
      #wag-dl-panel.minimized { width: auto; }
      #wag-dl-header {
        background: #16213e;
        padding: 10px 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        user-select: none;
      }
      #wag-dl-title {
        font-weight: 600;
        font-size: 14px;
        color: #fff;
      }
      #wag-dl-minimize {
        background: none;
        border: none;
        color: #aaa;
        font-size: 16px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      #wag-dl-minimize:hover { color: #fff; }
      #wag-dl-body { padding: 14px; }
      #wag-dl-status {
        margin-bottom: 10px;
        line-height: 1.4;
        min-height: 20px;
        color: #ccc;
      }
      #wag-dl-progress-wrap {
        height: 6px;
        background: #2a2a4a;
        border-radius: 3px;
        margin-bottom: 8px;
        overflow: hidden;
      }
      #wag-dl-progress-bar {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #0f3460, #e94560);
        border-radius: 3px;
        transition: width 0.3s ease;
      }
      #wag-dl-counts {
        font-size: 12px;
        color: #888;
        margin-bottom: 12px;
        min-height: 16px;
      }
      #wag-dl-actions, #wag-dl-export-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      #wag-dl-export-actions hr {
        width: 100%;
        border: none;
        border-top: 1px solid #2a2a4a;
        margin: 4px 0;
      }
      #wag-dl-export-actions label {
        font-size: 12px;
        color: #aaa;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #wag-dl-export-actions input {
        width: 60px;
        padding: 3px 6px;
        background: #2a2a4a;
        border: 1px solid #3a3a5a;
        border-radius: 4px;
        color: #e0e0e0;
        font-size: 12px;
      }
      .wag-btn {
        padding: 6px 14px;
        border: 1px solid #3a3a5a;
        border-radius: 6px;
        background: #2a2a4a;
        color: #e0e0e0;
        font-size: 12px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .wag-btn:hover { background: #3a3a5a; }
      .wag-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .wag-btn-primary {
        background: #0f3460;
        border-color: #0f3460;
        color: #fff;
      }
      .wag-btn-primary:hover { background: #1a4a80; }
      .wag-btn-danger {
        background: #8b0000;
        border-color: #8b0000;
        color: #fff;
      }
      .wag-btn-danger:hover { background: #a00000; }
      #wag-dl-section-label {
        width: 100%;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #666;
        margin-top: 2px;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);
    makeDraggable(panel, panel.querySelector("#wag-dl-header"));
    return panel;
  }

  function makeDraggable(el, handle) {
    let offsetX, offsetY, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      el.style.transition = "none";
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = e.clientX - offsetX + "px";
      el.style.top = e.clientY - offsetY + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => {
      dragging = false;
      el.style.transition = "";
    });
  }

  // ── State ───────────────────────────────────────────────────────

  let allAssets = [];
  let auth = null;
  let stopRequested = false;

  const $ = (sel) => document.querySelector(sel);

  function setStatus(msg) {
    $("#wag-dl-status").textContent = msg;
  }
  function setCounts(msg) {
    $("#wag-dl-counts").textContent = msg;
  }
  function setProgress(pct) {
    $("#wag-dl-progress-bar").style.width = pct + "%";
  }

  // ── Scan ────────────────────────────────────────────────────────

  async function scan() {
    allAssets = [];
    const scanBtn = $("#wag-dl-scan");
    scanBtn.disabled = true;
    scanBtn.textContent = "Scanning...";
    $("#wag-dl-export-actions").style.display = "none";
    setProgress(0);

    try {
      setStatus("Authenticating...");
      auth = await getOAuthInfo();
      setStatus(`Logged in (account ${auth.accountId}). Fetching date index...`);

      const dateIndex = await getDateIndex(auth);
      const dates = Object.entries(dateIndex).sort(([a], [b]) =>
        a.localeCompare(b)
      );
      const totalPhotos = dates.reduce((s, [, c]) => s + c, 0);
      setStatus(`Found ${dates.length} dates, ${totalPhotos.toLocaleString()} photos. Scanning...`);
      setCounts(`0 / ${totalPhotos.toLocaleString()} enumerated`);

      let enumerated = 0;
      for (const [date, count] of dates) {
        if (isTokenExpired(auth)) {
          auth = await getOAuthInfo();
        }

        const assets = await getAssetsForDate(auth, date, count);
        allAssets.push(...assets);
        enumerated += assets.length;
        const pct = ((enumerated / totalPhotos) * 100).toFixed(1);
        setProgress(pct);
        setCounts(
          `${enumerated.toLocaleString()} / ${totalPhotos.toLocaleString()} enumerated  |  ${date}`
        );
      }

      setStatus(
        `Scan complete. ${allAssets.length.toLocaleString()} downloadable photos found.`
      );
      setCounts("");
      setProgress(100);
      $("#wag-dl-export-actions").style.display = "flex";
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      console.error("[WagDL]", err);
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = "Scan Library";
    }
  }

  // ── Export ──────────────────────────────────────────────────────

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  async function copyUrls() {
    const text = allAssets.map((a) => a.url).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus(
        `Copied ${allAssets.length.toLocaleString()} URLs to clipboard. Paste into FDM with Ctrl+V.`
      );
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setStatus(
        `Copied ${allAssets.length.toLocaleString()} URLs to clipboard (fallback).`
      );
    }
  }

  function exportTxt() {
    const lines = allAssets.map((a) => a.url);
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    downloadBlob(blob, "walgreens-photo-urls.txt");
    setStatus(`Exported ${allAssets.length.toLocaleString()} URLs to .txt`);
  }

  function exportJson() {
    const data = allAssets.map((a) => ({
      url: a.url,
      filename: a.filename,
      date: a.date,
      md5: a.md5,
      size: a.size,
      width: a.width,
      height: a.height,
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, "walgreens-photo-details.json");
    setStatus(`Exported ${allAssets.length.toLocaleString()} photos to .json`);
  }

  // ── Batch trigger downloads ────────────────────────────────────

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function triggerDownloads() {
    const batchSize = parseInt($("#wag-dl-batch").value, 10) || 10;
    const delay = parseInt($("#wag-dl-delay").value, 10) || 500;
    stopRequested = false;

    const triggerBtn = $("#wag-dl-trigger");
    const stopBtn = $("#wag-dl-stop");
    triggerBtn.style.display = "none";
    stopBtn.style.display = "";

    let triggered = 0;
    const total = allAssets.length;

    for (let i = 0; i < total; i += batchSize) {
      if (stopRequested) {
        setStatus(
          `Stopped after ${triggered.toLocaleString()} / ${total.toLocaleString()} downloads triggered.`
        );
        break;
      }

      const batch = allAssets.slice(i, i + batchSize);
      for (const asset of batch) {
        const a = document.createElement("a");
        a.href = asset.url;
        a.download = asset.filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        triggered++;
      }

      const pct = ((triggered / total) * 100).toFixed(1);
      setProgress(pct);
      setCounts(
        `${triggered.toLocaleString()} / ${total.toLocaleString()} triggered`
      );
      setStatus(`Triggering downloads... batch ${Math.floor(i / batchSize) + 1}`);

      if (i + batchSize < total) await sleep(delay);
    }

    if (!stopRequested) {
      setStatus(
        `Done. ${triggered.toLocaleString()} downloads triggered for FDM.`
      );
      setProgress(100);
    }

    triggerBtn.style.display = "";
    stopBtn.style.display = "none";
  }

  // ── Init ────────────────────────────────────────────────────────

  function init() {
    createPanel();

    $("#wag-dl-minimize").addEventListener("click", () => {
      $("#wag-dl-panel").classList.toggle("minimized");
    });

    $("#wag-dl-scan").addEventListener("click", scan);
    $("#wag-dl-copy-urls").addEventListener("click", copyUrls);
    $("#wag-dl-export-txt").addEventListener("click", exportTxt);
    $("#wag-dl-export-json").addEventListener("click", exportJson);
    $("#wag-dl-trigger").addEventListener("click", triggerDownloads);
    $("#wag-dl-stop").addEventListener("click", () => {
      stopRequested = true;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
