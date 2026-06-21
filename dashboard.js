/**
 * PacTab — popup dashboard controller.
 * Renders a live view of open tabs and wires up quick actions.
 */

const $ = (id) => document.getElementById(id);

let state = {
  settings: null,
  tabs: [],
  windowCount: 0,
  stats: { autoClosed: 0, duplicatesClosed: 0 },
};
let filter = "";

const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function faviconFor(tab) {
  if (tab.favIconUrl && tab.favIconUrl.startsWith("http")) return tab.favIconUrl;
  const host = hostnameOf(tab.url || "");
  return host
    ? `https://www.google.com/s2/favicons?domain=${host}&sz=32`
    : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E";
}

function countDuplicates(tabs) {
  const seen = new Set();
  let dupes = 0;
  for (const t of tabs) {
    const key = (t.url || "").split("#")[0];
    if (!key) continue;
    if (seen.has(key)) dupes++;
    else seen.add(key);
  }
  return dupes;
}

/* ------------------------------- Rendering -------------------------------- */

function renderUsage() {
  const { settings } = state;
  const count = state.tabs.length;
  $("tab-count").textContent = count;
  $("tab-limit").textContent = settings.maxTabs;

  const pct = Math.min(100, Math.round((count / settings.maxTabs) * 100));
  const fill = $("usage-fill");
  fill.style.width = pct + "%";
  fill.className = "usage-fill" + (count > settings.maxTabs ? " over" : pct >= 80 ? " warn" : "");

  const hint = $("usage-hint");
  if (!settings.enabled) {
    hint.textContent = "Auto-limit is paused.";
  } else if (count > settings.maxTabs) {
    hint.textContent = `${count - settings.maxTabs} over your limit — strategy: ${settings.strategy}.`;
  } else {
    hint.textContent = `${settings.maxTabs - count} tabs of headroom left (${settings.scope}).`;
  }

  const dot = $("status-dot");
  dot.className = "dot" + (settings.enabled ? "" : " off");
}

function renderStats() {
  const domains = new Set(state.tabs.map((t) => hostnameOf(t.url || "")).filter(Boolean));
  $("stat-windows").textContent = state.windowCount;
  $("stat-dupes").textContent = countDuplicates(state.tabs);
  $("stat-domains").textContent = domains.size;
  $("stat-autoclosed").textContent = state.stats.autoClosed || 0;
}

function renderTabs() {
  const list = $("tab-list");
  list.innerHTML = "";

  const term = filter.trim().toLowerCase();
  const tabs = state.tabs.filter((t) => {
    if (!term) return true;
    return (
      (t.title || "").toLowerCase().includes(term) ||
      (t.url || "").toLowerCase().includes(term)
    );
  });

  if (!tabs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = term ? "No tabs match your search." : "No open tabs.";
    list.appendChild(empty);
    return;
  }

  // Group by hostname for a tidy overview.
  const groups = new Map();
  for (const tab of tabs) {
    const host = hostnameOf(tab.url || "") || "Other";
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(tab);
  }
  const sortedHosts = [...groups.keys()].sort(
    (a, b) => groups.get(b).length - groups.get(a).length
  );

  for (const host of sortedHosts) {
    const rows = groups.get(host);
    if (groups.size > 1) {
      const label = document.createElement("div");
      label.className = "group-label";
      label.textContent = `${host} · ${rows.length}`;
      list.appendChild(label);
    }
    for (const tab of rows) list.appendChild(buildRow(tab));
  }
}

function buildRow(tab) {
  const row = document.createElement("div");
  row.className = "tab-row" + (tab.active ? " active-tab" : "");
  row.title = tab.title || tab.url || "";

  const fav = document.createElement("img");
  fav.className = "tab-fav";
  fav.src = faviconFor(tab);
  fav.referrerPolicy = "no-referrer";
  fav.onerror = () => {
    fav.style.visibility = "hidden";
  };

  const meta = document.createElement("div");
  meta.className = "tab-meta";
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = tab.title || "Untitled";
  const sub = document.createElement("div");
  sub.className = "tab-host";
  sub.textContent = hostnameOf(tab.url || "") || tab.url || "";
  meta.append(title, sub);

  const badges = document.createElement("div");
  badges.className = "tab-badges";
  if (tab.pinned) badges.appendChild(makeBadge("pin", "PIN"));
  if (tab.audible) badges.appendChild(makeBadge("audio", "♪"));

  const close = document.createElement("button");
  close.className = "tab-close";
  close.title = "Close tab";
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  close.addEventListener("click", async (e) => {
    e.stopPropagation();
    await send({ type: "closeTab", tabId: tab.id });
    await refresh();
  });

  row.addEventListener("click", async () => {
    await send({ type: "activateTab", tabId: tab.id });
    window.close();
  });

  row.append(fav, meta, badges, close);
  return row;
}

function makeBadge(cls, text) {
  const b = document.createElement("span");
  b.className = "mini-badge " + cls;
  b.textContent = text;
  return b;
}

/* ------------------------------- Data flow -------------------------------- */

async function refresh() {
  const res = await send({ type: "getState" });
  if (!res) return;
  state = res;
  renderUsage();
  renderStats();
  renderTabs();
}

/* --------------------------------- Wiring --------------------------------- */

$("search").addEventListener("input", (e) => {
  filter = e.target.value;
  renderTabs();
});

$("btn-dupes").addEventListener("click", async () => {
  const res = await send({ type: "closeDuplicates" });
  await refresh();
  if (res?.closed != null) {
    $("footer-note").textContent =
      res.closed > 0 ? `Closed ${res.closed} duplicate tab(s).` : "No duplicates found.";
    setTimeout(() => (($("footer-note").textContent = "Click a tab to switch • hover to close")), 2500);
  }
});

$("btn-enforce").addEventListener("click", async () => {
  await send({ type: "enforceNow" });
  await refresh();
});

$("toggle-enabled").addEventListener("click", async () => {
  const next = { ...state.settings, enabled: !state.settings.enabled };
  await send({ type: "saveSettings", settings: next });
  await refresh();
});

$("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh();
