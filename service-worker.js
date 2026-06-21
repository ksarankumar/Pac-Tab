/**
 * PacTab — Munch the clutter, save the RAM
 * Background service worker.
 *
 * Responsibilities:
 *  - Maintain user settings (with sane defaults) in chrome.storage.sync.
 *  - Enforce a configurable tab budget per-window or globally, using a
 *    selectable strategy (close oldest, close newest, or warn-only).
 *  - Respect protected tabs (pinned, audible, active, and whitelisted domains).
 *  - Keep the toolbar badge in sync with the current tab usage.
 *  - Provide a message API used by the popup dashboard and options page.
 */

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  maxTabs: 15,
  scope: "window", // "window" | "global"
  strategy: "oldest", // "oldest" | "newest" | "warn"
  protectPinned: true,
  protectAudible: true,
  protectActive: true,
  whitelist: [], // array of hostnames that are never auto-closed
  notify: true,
  showBadge: true,
});

const STORAGE_KEY = "settings";
const STATS_KEY = "stats";

/* ----------------------------- Settings cache ----------------------------- */

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] || {}) };
  return settings;
}

async function saveSettings(next) {
  settings = { ...DEFAULT_SETTINGS, ...next };
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  return settings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[STORAGE_KEY]) {
    settings = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue || {}) };
    refreshBadge();
  }
});

/* -------------------------------- Helpers --------------------------------- */

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isWhitelisted(tab) {
  if (!settings.whitelist.length) return false;
  const host = hostnameOf(tab.url || tab.pendingUrl || "");
  if (!host) return false;
  return settings.whitelist.some(
    (entry) => host === entry || host.endsWith("." + entry)
  );
}

function isProtected(tab) {
  if (settings.protectPinned && tab.pinned) return true;
  if (settings.protectAudible && tab.audible) return true;
  if (settings.protectActive && tab.active) return true;
  if (isWhitelisted(tab)) return true;
  return false;
}

async function getRelevantTabs(windowId) {
  if (settings.scope === "global") {
    return chrome.tabs.query({ windowType: "normal" });
  }
  return chrome.tabs.query({ windowType: "normal", windowId });
}

/* ------------------------------ Statistics -------------------------------- */

async function bumpStat(key, amount = 1) {
  const stored = await chrome.storage.local.get(STATS_KEY);
  const stats = stored[STATS_KEY] || { autoClosed: 0, duplicatesClosed: 0 };
  stats[key] = (stats[key] || 0) + amount;
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

/* ----------------------------- Notifications ------------------------------ */

function notify(title, message) {
  if (!settings.notify) return;
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 0,
    });
  } catch {
    /* notifications may be unavailable; fail silently */
  }
}

/* ----------------------------- Badge handling ----------------------------- */

async function refreshBadge() {
  try {
    if (!settings.showBadge) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    let count;
    if (settings.scope === "global") {
      count = (await chrome.tabs.query({ windowType: "normal" })).length;
    } else {
      const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      count = (await chrome.tabs.query({ windowId: win.id })).length;
    }
    const overLimit = settings.enabled && count > settings.maxTabs;
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({
      color: overLimit ? "#ef4444" : "#14b8a6",
    });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
  } catch {
    /* window may not exist yet */
  }
}

/* ----------------------------- Enforcement -------------------------------- */

let enforcing = false;

async function enforceLimit(windowId) {
  if (!settings.enabled || enforcing) return;
  enforcing = true;
  try {
    const tabs = await getRelevantTabs(windowId);
    if (tabs.length <= settings.maxTabs) return;

    const overflow = tabs.length - settings.maxTabs;

    if (settings.strategy === "warn") {
      notify(
        "Tab limit reached",
        `You have ${tabs.length} tabs open (limit ${settings.maxTabs}).`
      );
      return;
    }

    const closable = tabs.filter((t) => !isProtected(t));
    if (!closable.length) return;

    // Oldest = lowest tab id; newest = highest tab id.
    closable.sort((a, b) =>
      settings.strategy === "newest" ? b.id - a.id : a.id - b.id
    );

    const victims = closable.slice(0, overflow).map((t) => t.id);
    if (!victims.length) return;

    await chrome.tabs.remove(victims);
    await bumpStat("autoClosed", victims.length);
    notify(
      "PacTab tidied up",
      `Closed ${victims.length} ${
        victims.length === 1 ? "tab" : "tabs"
      } to stay within your limit of ${settings.maxTabs}.`
    );
  } catch {
    /* tabs may already be gone */
  } finally {
    enforcing = false;
    refreshBadge();
  }
}

/* --------------------------- Duplicate cleanup ---------------------------- */

async function closeDuplicates() {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const seen = new Set();
  const dupes = [];
  for (const tab of tabs) {
    const key = (tab.url || tab.pendingUrl || "").split("#")[0];
    if (!key) continue;
    if (seen.has(key)) {
      if (!tab.pinned && !tab.active) dupes.push(tab.id);
    } else {
      seen.add(key);
    }
  }
  if (dupes.length) {
    await chrome.tabs.remove(dupes);
    await bumpStat("duplicatesClosed", dupes.length);
  }
  refreshBadge();
  return dupes.length;
}

/* ------------------------------ Event wiring ------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  refreshBadge();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!settings.enabled) {
    refreshBadge();
    return;
  }
  // Defer slightly so the new tab's URL settles before whitelist checks.
  setTimeout(() => enforceLimit(tab.windowId), 250);
});

chrome.tabs.onRemoved.addListener(() => refreshBadge());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete") refreshBadge();
});
chrome.windows.onFocusChanged.addListener(() => refreshBadge());

/* ------------------------------ Message API ------------------------------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await loadSettings();
    switch (message?.type) {
      case "getState": {
        const tabs = await chrome.tabs.query({ windowType: "normal" });
        const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
        const statsStore = await chrome.storage.local.get(STATS_KEY);
        sendResponse({
          settings,
          tabs,
          windowCount: windows.length,
          stats: statsStore[STATS_KEY] || {
            autoClosed: 0,
            duplicatesClosed: 0,
          },
        });
        break;
      }
      case "saveSettings": {
        const saved = await saveSettings(message.settings);
        await refreshBadge();
        await enforceLimit((await chrome.windows.getLastFocused()).id);
        sendResponse({ settings: saved });
        break;
      }
      case "activateTab": {
        await chrome.tabs.update(message.tabId, { active: true });
        const tab = await chrome.tabs.get(message.tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        sendResponse({ ok: true });
        break;
      }
      case "closeTab": {
        await chrome.tabs.remove(message.tabId);
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }
      case "closeTabs": {
        await chrome.tabs.remove(message.tabIds);
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }
      case "closeDuplicates": {
        const closed = await closeDuplicates();
        sendResponse({ closed });
        break;
      }
      case "enforceNow": {
        const win = await chrome.windows.getLastFocused();
        await enforceLimit(win.id);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ error: "unknown_message" });
    }
  })();
  return true; // keep the message channel open for async response
});

// Initialise on worker spin-up.
loadSettings().then(refreshBadge);

