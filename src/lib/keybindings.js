const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

export const KEYBINDING_ACTIONS = [
  { id: "app.search", label: "Search Requests and Commands", section: "General", defaultShortcut: "Mod+K", allowInInput: true },
  { id: "app.openSettings", label: "Show App Preferences", section: "General", defaultShortcut: "Mod+,", allowInInput: true },
  { id: "app.openKeybindings", label: "Show Keybindings", section: "General", defaultShortcut: "Mod+Shift+K", allowInInput: true },
  { id: "app.openCollectionSettings", label: "Show Collection Settings", section: "General", defaultShortcut: "Mod+Shift+," },
  { id: "view.toggleTheme", label: "Toggle Theme", section: "General", defaultShortcut: "Mod+Shift+L", allowInInput: true },
  { id: "collection.duplicate", label: "Duplicate Collection", section: "Collection", defaultShortcut: "Mod+Shift+D" },
  { id: "collection.delete", label: "Delete Collection", section: "Collection", defaultShortcut: "Mod+Shift+Delete" },
  { id: "request.send", label: "Send Request", section: "Request", defaultShortcut: "Mod+Enter", allowInInput: true },
  { id: "request.cancel", label: "Cancel Send", section: "Request", defaultShortcut: "Mod+Shift+Enter", allowInInput: true },
  { id: "request.new", label: "Create HTTP Request", section: "Request", defaultShortcut: "Mod+N" },
  { id: "request.duplicate", label: "Duplicate Request", section: "Request", defaultShortcut: "Mod+D" },
  { id: "request.copy", label: "Copy Request", section: "Request", defaultShortcut: "Mod+Shift+C" },
  { id: "request.paste", label: "Paste Request", section: "Request", defaultShortcut: "Mod+Shift+V" },
  { id: "request.delete", label: "Delete Request", section: "Request", defaultShortcut: "Mod+Delete" },
  { id: "tab.close", label: "Close Request Tab", section: "Tabs", defaultShortcut: "Mod+W" },
  { id: "tab.next", label: "Next Request Tab", section: "Tabs", defaultShortcut: "Mod+Tab" },
  { id: "tab.previous", label: "Previous Request Tab", section: "Tabs", defaultShortcut: "Mod+Shift+Tab" },
  { id: "sidebar.toggle", label: "Toggle Sidebar", section: "View", defaultShortcut: "Mod+\\" },
  { id: "view.zoomIn", label: "Zoom In", section: "View", defaultShortcut: "Mod+=" },
  { id: "view.zoomOut", label: "Zoom Out", section: "View", defaultShortcut: "Mod+-" },
  { id: "view.zoomReset", label: "Reset Zoom", section: "View", defaultShortcut: "Mod+0" },
];

const MODIFIER_ORDER = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];

function normalizeModifier(token) {
  const value = String(token || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "mod") return "Mod";
  if (value === "ctrl" || value === "control") return "Ctrl";
  if (value === "meta" || value === "cmd" || value === "command") return "Meta";
  if (value === "alt" || value === "option") return "Alt";
  if (value === "shift") return "Shift";
  return "";
}

function normalizePrimaryKey(token) {
  const raw = String(token || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();

  const aliases = {
    esc: "Esc",
    escape: "Esc",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    space: "Space",
    spacebar: "Space",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    arrowup: "ArrowUp",
    up: "ArrowUp",
    arrowdown: "ArrowDown",
    down: "ArrowDown",
    arrowleft: "ArrowLeft",
    left: "ArrowLeft",
    arrowright: "ArrowRight",
    right: "ArrowRight",
  };

  if (aliases[lower]) {
    return aliases[lower];
  }

  if (/^f([1-9]|1[0-2])$/i.test(raw)) {
    return raw.toUpperCase();
  }

  if (raw.length === 1) {
    return raw.toUpperCase();
  }

  return raw;
}

function parseShortcut(shortcut) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return null;
  const parts = normalized.split("+");
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  return {
    key,
    mod: modifiers.has("Mod"),
    ctrl: modifiers.has("Ctrl"),
    meta: modifiers.has("Meta"),
    alt: modifiers.has("Alt"),
    shift: modifiers.has("Shift"),
  };
}

export function createDefaultKeybindings() {
  return KEYBINDING_ACTIONS.reduce((acc, action) => {
    acc[action.id] = action.defaultShortcut;
    return acc;
  }, {});
}

export function normalizeShortcut(shortcut) {
  const value = String(shortcut || "").trim();
  if (!value) return "";

  const parts = value
    .split("+")
    .map((token) => String(token || "").trim())
    .filter(Boolean);

  if (parts.length === 0) return "";

  const normalizedModifiers = [];
  let primary = "";

  for (const token of parts) {
    const modifier = normalizeModifier(token);
    if (modifier) {
      normalizedModifiers.push(modifier);
      continue;
    }
    primary = normalizePrimaryKey(token);
  }

  if (!primary) return "";

  const uniqueModifiers = Array.from(new Set(normalizedModifiers));
  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => uniqueModifiers.includes(modifier));
  return [...orderedModifiers, primary].join("+");
}

export function normalizeKeybindingMap(value) {
  const defaults = createDefaultKeybindings();
  const source = value && typeof value === "object" ? value : {};
  const next = { ...defaults };

  Object.keys(source).forEach((actionId) => {
    if (!(actionId in defaults)) return;
    const normalized = normalizeShortcut(source[actionId]);
    next[actionId] = normalized || defaults[actionId];
  });

  return next;
}

export function keyboardEventToShortcut(event) {
  const modifiers = [];
  if (event.ctrlKey || event.metaKey) {
    modifiers.push("Mod");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }

  const key = normalizePrimaryKey(event.key);
  if (!key || ["Shift", "Alt", "Control", "Meta"].includes(key)) {
    return "";
  }

  return normalizeShortcut([...modifiers, key].join("+"));
}

function eventKeyMatches(expectedKey, eventKey) {
  if (expectedKey === eventKey) return true;
  if (expectedKey === "=" && eventKey === "+") return true;
  if (expectedKey === "-" && eventKey === "_") return true;
  return false;
}

export function doesEventMatchShortcut(event, shortcut) {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;

  const hasCtrlOrMeta = event.ctrlKey || event.metaKey;

  if (parsed.mod && !hasCtrlOrMeta) return false;
  if (!parsed.mod && !parsed.ctrl && !parsed.meta && hasCtrlOrMeta) return false;

  if (parsed.ctrl && !event.ctrlKey) return false;
  if (parsed.meta && !event.metaKey) return false;
  if (!parsed.mod && !parsed.ctrl && event.ctrlKey) return false;
  if (!parsed.mod && !parsed.meta && event.metaKey) return false;

  if (parsed.alt !== event.altKey) return false;
  if (parsed.shift !== event.shiftKey) return false;

  const eventKey = normalizePrimaryKey(event.key);
  return eventKeyMatches(parsed.key, eventKey);
}

export function shortcutToDisplay(shortcut) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return "Not set";

  return normalized
    .split("+")
    .map((token) => {
      if (token === "Mod") return IS_MAC ? "Cmd" : "Ctrl";
      if (token === "Meta") return "Cmd";
      if (token === "Alt") return IS_MAC ? "Option" : "Alt";
      return token;
    })
    .join(" + ");
}

export function isEditableEventTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = String(target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(target.isContentEditable || target.closest("[contenteditable='true']"));
}
