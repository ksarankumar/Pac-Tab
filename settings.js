/**
 * PacTab — settings page controller.
 */

const DEFAULTS = {
  enabled: true,
  maxTabs: 15,
  scope: "window",
  strategy: "oldest",
  protectPinned: true,
  protectAudible: true,
  protectActive: true,
  whitelist: [],
  notify: true,
  showBadge: true,
};

const $ = (id) => document.getElementById(id);
let current = { ...DEFAULTS };

const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

/* ------------------------------- Rendering -------------------------------- */

function setSeg(groupId, value) {
  $(groupId)
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.value === value));
}

function renderWhitelist() {
  const list = $("wl-list");
  list.innerHTML = "";
  if (!current.whitelist.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No domains added yet.";
    list.appendChild(li);
    return;
  }
  current.whitelist.forEach((domain, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = domain;
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", () => {
      current.whitelist.splice(i, 1);
      renderWhitelist();
    });
    li.append(span, x);
    list.appendChild(li);
  });
}

function render() {
  $("enabled").checked = current.enabled;
  $("maxTabs").value = current.maxTabs;
  $("maxTabsOut").textContent = current.maxTabs;
  setSeg("scope", current.scope);
  setSeg("strategy", current.strategy);
  $("protectPinned").checked = current.protectPinned;
  $("protectAudible").checked = current.protectAudible;
  $("protectActive").checked = current.protectActive;
  $("notify").checked = current.notify;
  $("showBadge").checked = current.showBadge;
  renderWhitelist();
}

/* ------------------------------- Data flow -------------------------------- */

function collect() {
  return {
    ...current,
    enabled: $("enabled").checked,
    maxTabs: parseInt($("maxTabs").value, 10),
    protectPinned: $("protectPinned").checked,
    protectAudible: $("protectAudible").checked,
    protectActive: $("protectActive").checked,
    notify: $("notify").checked,
    showBadge: $("showBadge").checked,
  };
}

function normalizeDomain(value) {
  let v = value.trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return v;
}

async function load() {
  const res = await send({ type: "getState" });
  current = { ...DEFAULTS, ...(res?.settings || {}) };
  render();
}

async function save() {
  current = collect();
  await send({ type: "saveSettings", settings: current });
  const note = $("saved-note");
  note.textContent = "Settings saved ✓";
  setTimeout(() => (note.textContent = ""), 2000);
}

/* --------------------------------- Wiring --------------------------------- */

$("maxTabs").addEventListener("input", (e) => {
  $("maxTabsOut").textContent = e.target.value;
});

["scope", "strategy"].forEach((groupId) => {
  $(groupId).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    current[groupId] = btn.dataset.value;
    setSeg(groupId, btn.dataset.value);
  });
});

$("wl-add").addEventListener("click", addDomain);
$("wl-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addDomain();
});

function addDomain() {
  const domain = normalizeDomain($("wl-input").value);
  if (domain && !current.whitelist.includes(domain)) {
    current.whitelist.push(domain);
    renderWhitelist();
  }
  $("wl-input").value = "";
}

$("save").addEventListener("click", save);

$("reset").addEventListener("click", async () => {
  current = { ...DEFAULTS, whitelist: [] };
  render();
  await save();
});

load();
