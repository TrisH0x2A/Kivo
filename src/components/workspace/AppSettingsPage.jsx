import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BookOpen, Cookie, ExternalLink, FileText, FolderOpen, Github, HardDrive, Heart, Keyboard, Lightbulb, Palette, Plus, RefreshCw, Settings2, ShieldCheck, Siren, Star, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { clearCookieJar, deleteCookieJarEntry, getAppSettings, getCookieJar, setAppSettings, switchStoragePath, upsertCookieJarEntry, validateStoragePath } from "@/lib/http-client.js";
import { createDefaultKeybindings, keyboardEventToShortcut, KEYBINDING_ACTIONS, normalizeKeybindingMap, shortcutToDisplay } from "@/lib/keybindings.js";
import { THEME_OPTIONS } from "@/lib/themes.js";

const EMPTY_COOKIE_DRAFT = {
  id: "",
  name: "",
  value: "",
  domain: "",
  path: "/",
  expiresAt: "",
  sameSite: "",
  secure: false,
  httpOnly: false,
  hostOnly: true,
  workspaceName: "",
  collectionName: "",
};

const SETTINGS_TABS = ["Storage", "Theme", "Security", "Keybindings", "Proxy", "Cookie Jar", "History", "Updates", "Resources"];

const DEFAULT_APP_SETTINGS = {
  clearOAuthSessionOnStart: false,
  validateCertificatesDuringAuthentication: true,
  sslTlsCertificateVerification: true,
  useCustomCaCertificate: false,
  customCaCertificatePath: "",
  keepDefaultCaCertificates: true,
  storeLastResponseByDefault: false,
  storeCookiesAutomatically: true,
  sendCookiesAutomatically: true,
  useSystemBrowserForOauth2Authorization: true,
  requestTimeoutMs: 0,
  proxyEnabled: false,
  proxyHttp: "",
  proxyHttps: "",
  noProxy: "",
  proxyUsername: "",
  proxyPassword: "",
  useClientCertificate: false,
  clientCertificatePath: "",
  clientKeyPath: "",
  keybindings: createDefaultKeybindings(),
};

function normalizeAppSettingsInput(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    ...DEFAULT_APP_SETTINGS,
    ...source,
    clearOAuthSessionOnStart: Boolean(source.clearOAuthSessionOnStart ?? DEFAULT_APP_SETTINGS.clearOAuthSessionOnStart),
    validateCertificatesDuringAuthentication: Boolean(source.validateCertificatesDuringAuthentication ?? DEFAULT_APP_SETTINGS.validateCertificatesDuringAuthentication),
    sslTlsCertificateVerification: Boolean(source.sslTlsCertificateVerification ?? DEFAULT_APP_SETTINGS.sslTlsCertificateVerification),
    useCustomCaCertificate: Boolean(source.useCustomCaCertificate ?? DEFAULT_APP_SETTINGS.useCustomCaCertificate),
    customCaCertificatePath: String(source.customCaCertificatePath ?? DEFAULT_APP_SETTINGS.customCaCertificatePath),
    keepDefaultCaCertificates: true,
    storeLastResponseByDefault: Boolean(source.storeLastResponseByDefault ?? DEFAULT_APP_SETTINGS.storeLastResponseByDefault),
    storeCookiesAutomatically: Boolean(source.storeCookiesAutomatically ?? DEFAULT_APP_SETTINGS.storeCookiesAutomatically),
    sendCookiesAutomatically: Boolean(source.sendCookiesAutomatically ?? DEFAULT_APP_SETTINGS.sendCookiesAutomatically),
    useSystemBrowserForOauth2Authorization: Boolean(source.useSystemBrowserForOauth2Authorization ?? DEFAULT_APP_SETTINGS.useSystemBrowserForOauth2Authorization),
    requestTimeoutMs: Number.isFinite(source.requestTimeoutMs) ? Math.max(0, Number(source.requestTimeoutMs)) : 0,
    proxyEnabled: Boolean(source.proxyEnabled ?? DEFAULT_APP_SETTINGS.proxyEnabled),
    proxyHttp: String(source.proxyHttp ?? DEFAULT_APP_SETTINGS.proxyHttp),
    proxyHttps: String(source.proxyHttps ?? DEFAULT_APP_SETTINGS.proxyHttps),
    noProxy: String(source.noProxy ?? DEFAULT_APP_SETTINGS.noProxy),
    proxyUsername: String(source.proxyUsername ?? DEFAULT_APP_SETTINGS.proxyUsername),
    proxyPassword: String(source.proxyPassword ?? DEFAULT_APP_SETTINGS.proxyPassword),
    useClientCertificate: Boolean(source.useClientCertificate ?? DEFAULT_APP_SETTINGS.useClientCertificate),
    clientCertificatePath: String(source.clientCertificatePath ?? DEFAULT_APP_SETTINGS.clientCertificatePath),
    clientKeyPath: String(source.clientKeyPath ?? DEFAULT_APP_SETTINGS.clientKeyPath),
    keybindings: normalizeKeybindingMap(source.keybindings ?? DEFAULT_APP_SETTINGS.keybindings),
  };
}

function normalizePath(path) {
  return String(path ?? "").trim().replace(/[\\/]+$/, "").toLowerCase();
}

function resolveKivoStoragePath(base) {
  const trimmed = String(base ?? "").trim();
  if (!trimmed) return "";
  const lastSegment = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  if (lastSegment.toLowerCase() === "kivo") {
    return trimmed;
  }
  const isWindows = /^[A-Za-z]:[/\\]/.test(trimmed);
  const sep = isWindows ? "\\" : "/";
  const baseWithoutTrailing = trimmed.replace(/[\\/]+$/, "");
  return `${baseWithoutTrailing}${sep}Kivo`;
}

export function AppSettingsPage({ storagePath, onStoragePathChanged, initialTab = "Storage", theme = "dark", onThemeChange, requestHistory = [], onClearHistory }) {
  const [pathInput, setPathInput] = useState(storagePath ?? "");
  const [mode, setMode] = useState("copy");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pathValidation, setPathValidation] = useState(null);
  const [pathError, setPathError] = useState("");
  const [appVersion, setAppVersion] = useState("...");
  const [updaterStatus, setUpdaterStatus] = useState("idle");
  const [cookieEntries, setCookieEntries] = useState([]);
  const [cookieFilter, setCookieFilter] = useState("");
  const [isCookieLoading, setIsCookieLoading] = useState(false);
  const [cookieDraft, setCookieDraft] = useState(EMPTY_COOKIE_DRAFT);
  const [isCookieEditorOpen, setIsCookieEditorOpen] = useState(false);
  const [isSavingCookie, setIsSavingCookie] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState("Storage");
  const [appSettings, setSettingsState] = useState(DEFAULT_APP_SETTINGS);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [editingShortcutActionId, setEditingShortcutActionId] = useState("");
  const [shortcutDraft, setShortcutDraft] = useState("");
  const [shortcutError, setShortcutError] = useState("");

  useEffect(() => {
    setPathInput(storagePath ?? "");
  }, [storagePath]);

  useEffect(() => {
    if (SETTINGS_TABS.includes(initialTab)) {
      setActiveSettingsTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});

    const handleStatusChange = (event) => {
      setUpdaterStatus(event.detail.status);
    };

    window.addEventListener("updater-status-change", handleStatusChange);
    window.dispatchEvent(new CustomEvent("updater-status-request"));

    return () => window.removeEventListener("updater-status-change", handleStatusChange);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadCookies() {
      setIsCookieLoading(true);
      try {
        const list = await getCookieJar(null, null);
        if (!cancelled) {
          setCookieEntries(Array.isArray(list) ? list : []);
        }
      } catch {
        if (!cancelled) {
          setCookieEntries([]);
        }
      } finally {
        if (!cancelled) {
          setIsCookieLoading(false);
        }
      }
    }

    loadCookies();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        const settings = await getAppSettings();
        if (!cancelled) {
          setSettingsState(normalizeAppSettingsInput(settings));
        }
      } catch {
        if (!cancelled) {
          setSettingsState(DEFAULT_APP_SETTINGS);
        }
      }
    }

    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  const isSamePath = useMemo(
    () => normalizePath(resolveKivoStoragePath(pathInput)) === normalizePath(storagePath),
    [pathInput, storagePath]
  );

  const resolvedTargetPath = useMemo(() => resolveKivoStoragePath(pathInput), [pathInput]);

  async function handleOpenExternal(url, label) {
    try {
      await openUrl(url);
    } catch {
    }
  }

  async function persistSettings(nextSettings) {
    const normalized = normalizeAppSettingsInput(nextSettings);
    setSettingsState(normalized);
    setIsSavingSettings(true);
    try {
      const saved = await setAppSettings(normalized);
      const normalizedSaved = normalizeAppSettingsInput(saved);
      setSettingsState(normalizedSaved);
      window.dispatchEvent(new CustomEvent("kivo-app-settings-updated", { detail: normalizedSaved }));
    } catch {
    } finally {
      setIsSavingSettings(false);
    }
  }

  function updateSettingsPatch(patch) {
    const next = normalizeAppSettingsInput({ ...appSettings, ...patch });
    return persistSettings(next);
  }

  async function handleSelectCustomCaPath() {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [
          { name: "Certificates", extensions: ["pem", "crt", "cer", "der"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (!selected) return;
      await updateSettingsPatch({
        customCaCertificatePath: String(selected),
        useCustomCaCertificate: true,
      });
    } catch {
    }
  }

  async function handleBrowse() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: pathInput || storagePath || undefined,
      });
      if (selected) {
        setPathInput(selected);
        setPathError("");
        setPathValidation(null);
      }
    } catch {
    }
  }

  async function handleValidate() {
    if (!resolvedTargetPath) {
      setPathError("Path is required.");
      setPathValidation(null);
      return null;
    }

    try {
      const result = await validateStoragePath(resolvedTargetPath);
      setPathValidation(result);
      setPathError("");
      return result;
    } catch (error) {
      const message = String(error ?? "Invalid path.");
      setPathError(message);
      setPathValidation(null);
      return null;
    }
  }

  async function handleApplyPath() {
    if (isSamePath) {
      setPathError("Selected path is already the current storage path.");
      return;
    }

    const validation = await handleValidate();
    if (!validation) return;

    if (validation.exists && !validation.isDirectory) {
      setPathError("Selected path must be a directory.");
      return;
    }
    if (!validation.writable) {
      setPathError("Selected path is not writable.");
      return;
    }

    setIsSubmitting(true);
    try {
      await switchStoragePath(resolvedTargetPath, mode);
      onStoragePathChanged?.(resolvedTargetPath);
    } catch (error) {
      setPathError(String(error ?? "Failed to switch storage path."));
    } finally {
      setIsSubmitting(false);
    }
  }

  const validationTone = pathValidation
    ? pathValidation.exists && pathValidation.isDirectory && pathValidation.writable
      ? "text-emerald-400"
      : "text-amber-400"
    : "text-muted-foreground";

  const statusTone =
    updaterStatus === "available"
      ? "bg-emerald-500/12 text-emerald-400 border-emerald-500/30"
      : updaterStatus === "downloading"
        ? "bg-blue-500/12 text-blue-400 border-blue-500/30"
        : "bg-muted/35 text-muted-foreground border-border/30";

  const reportIssueUrl = useMemo(() => {
    const body = [
      "## Bug Summary",
      "Briefly describe what went wrong.",
      "",
      "## Steps To Reproduce",
      "1. Go to ...",
      "2. Click on ...",
      "3. See error ...",
      "",
      "## Expected Behavior",
      "What did you expect to happen?",
      "",
      "## Actual Behavior",
      "What actually happened?",
      "",
      "## Environment",
      `- App Version: v${appVersion}`,
      `- Platform: `,
      "",
      "## Additional Context",
      "Screenshots, logs, or anything else helpful.",
    ].join("\n");

    const params = new URLSearchParams({
      title: "[Bug]: ",
      labels: "bug",
      body,
    });

    return `https://github.com/DevlogZz/Kivo/issues/new?${params.toString()}`;
  }, [appVersion]);

  const featureRequestUrl = useMemo(() => {
    const body = [
      "## Feature Summary",
      "Describe the feature you'd like to see.",
      "",
      "## Problem / Use Case",
      "What problem would this solve for you?",
      "",
      "## Proposed Solution",
      "How should this feature work?",
      "",
      "## Additional Context",
      "Add mockups, examples, or notes.",
    ].join("\n");

    const params = new URLSearchParams({
      title: "[FeatureRequest]",
      labels: "enhancement",
      body,
    });

    return `https://github.com/DevlogZz/Kivo/issues/new?${params.toString()}`;
  }, []);

  const filteredCookies = useMemo(() => {
    const query = cookieFilter.trim().toLowerCase();
    if (!query) {
      return cookieEntries;
    }
    return cookieEntries.filter((entry) => {
      const name = String(entry?.name ?? "").toLowerCase();
      const domain = String(entry?.domain ?? "").toLowerCase();
      const path = String(entry?.path ?? "").toLowerCase();
      const sameSite = String(entry?.sameSite ?? "").toLowerCase();
      const workspace = String(entry?.workspaceName ?? "").toLowerCase();
      const collection = String(entry?.collectionName ?? "").toLowerCase();
      return name.includes(query)
        || domain.includes(query)
        || path.includes(query)
        || sameSite.includes(query)
        || workspace.includes(query)
        || collection.includes(query);
    });
  }, [cookieEntries, cookieFilter]);

  const keybindingSections = useMemo(() => {
    return KEYBINDING_ACTIONS.reduce((acc, action) => {
      const section = action.section || "General";
      if (!acc[section]) {
        acc[section] = [];
      }
      acc[section].push(action);
      return acc;
    }, {});
  }, []);

  const editingShortcutAction = useMemo(
    () => KEYBINDING_ACTIONS.find((item) => item.id === editingShortcutActionId) || null,
    [editingShortcutActionId]
  );

  const lightThemes = useMemo(() => THEME_OPTIONS.filter((item) => item.appearance === "light"), []);
  const darkThemes = useMemo(() => THEME_OPTIONS.filter((item) => item.appearance !== "light"), []);

  function findShortcutConflict(actionId, shortcutValue) {
    const normalized = String(shortcutValue || "").trim();
    if (!normalized) return null;

    for (const action of KEYBINDING_ACTIONS) {
      if (action.id === actionId) continue;
      const assigned = appSettings.keybindings?.[action.id] || "";
      if (assigned === normalized) {
        return action;
      }
    }

    return null;
  }

  function openShortcutEditor(actionId) {
    setEditingShortcutActionId(actionId);
    setShortcutDraft(appSettings.keybindings?.[actionId] || "");
    setShortcutError("");
  }

  function closeShortcutEditor() {
    setEditingShortcutActionId("");
    setShortcutDraft("");
    setShortcutError("");
  }

  async function saveShortcutForAction(actionId, shortcut) {
    const nextMap = normalizeKeybindingMap({
      ...appSettings.keybindings,
      [actionId]: shortcut,
    });

    const normalizedShortcut = nextMap[actionId] || "";
    const conflictAction = findShortcutConflict(actionId, normalizedShortcut);
    if (conflictAction) {
      setShortcutError(`Already used by "${conflictAction.label}".`);
      return false;
    }

    await updateSettingsPatch({ keybindings: nextMap });
    return true;
  }

  async function handleResetSingleShortcut(actionId) {
    const defaults = createDefaultKeybindings();
    await saveShortcutForAction(actionId, defaults[actionId] || "");
  }

  async function handleResetAllShortcuts() {
    await updateSettingsPatch({ keybindings: createDefaultKeybindings() });
  }

  async function handleShortcutEditorKeyDown(event) {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      closeShortcutEditor();
      return;
    }

    if (event.key === "Enter") {
      if (!editingShortcutActionId || !shortcutDraft) {
        setShortcutError("Press a key combination first.");
        return;
      }
      const didSave = await saveShortcutForAction(editingShortcutActionId, shortcutDraft);
      if (!didSave) {
        return;
      }
      closeShortcutEditor();
      return;
    }

    const captured = keyboardEventToShortcut(event);
    if (!captured) {
      return;
    }

    setShortcutDraft(captured);
    const conflictAction = findShortcutConflict(editingShortcutActionId, captured);
    if (conflictAction) {
      setShortcutError(`Already used by "${conflictAction.label}".`);
      return;
    }
    setShortcutError("");
  }

  function resetCookieDraft() {
    setCookieDraft(EMPTY_COOKIE_DRAFT);
  }

  function handleEditCookie(entry) {
    setCookieDraft({
      id: String(entry?.id ?? ""),
      name: String(entry?.name ?? ""),
      value: String(entry?.value ?? ""),
      domain: String(entry?.domain ?? ""),
      path: String(entry?.path ?? "/") || "/",
      expiresAt: String(entry?.expiresAt ?? ""),
      sameSite: String(entry?.sameSite ?? ""),
      secure: Boolean(entry?.secure),
      httpOnly: Boolean(entry?.httpOnly),
      hostOnly: entry?.hostOnly ?? true,
      workspaceName: String(entry?.workspaceName ?? ""),
      collectionName: String(entry?.collectionName ?? ""),
    });
    setIsCookieEditorOpen(true);
  }

  function openAddCookieModal() {
    resetCookieDraft();
    setIsCookieEditorOpen(true);
  }

  function closeCookieEditor() {
    setIsCookieEditorOpen(false);
  }

  async function handleSaveCookie() {
    if (!cookieDraft.name.trim() || !cookieDraft.domain.trim()) {
      return;
    }

    setIsSavingCookie(true);
    try {
      const saved = await upsertCookieJarEntry({
        id: cookieDraft.id || null,
        name: cookieDraft.name.trim(),
        value: cookieDraft.value,
        domain: cookieDraft.domain.trim(),
        path: cookieDraft.path.trim() || "/",
        expiresAt: cookieDraft.expiresAt.trim() ? cookieDraft.expiresAt.trim() : null,
        sameSite: cookieDraft.sameSite.trim(),
        secure: Boolean(cookieDraft.secure),
        httpOnly: Boolean(cookieDraft.httpOnly),
        hostOnly: Boolean(cookieDraft.hostOnly),
        workspaceName: cookieDraft.workspaceName.trim(),
        collectionName: cookieDraft.collectionName.trim(),
      });

      setCookieEntries((prev) => {
        const next = prev.filter((entry) => entry.id !== saved.id);
        return [...next, saved].sort((a, b) => `${a.domain}${a.path}${a.name}`.localeCompare(`${b.domain}${b.path}${b.name}`));
      });
      setIsCookieEditorOpen(false);
      resetCookieDraft();
    } catch {
    } finally {
      setIsSavingCookie(false);
    }
  }

  async function reloadCookies() {
    setIsCookieLoading(true);
    try {
      const list = await getCookieJar(null, null);
      setCookieEntries(Array.isArray(list) ? list : []);
    } catch {
    } finally {
      setIsCookieLoading(false);
    }
  }

  async function handleDeleteCookie(id) {
    try {
      const removed = await deleteCookieJarEntry(id);
      if (removed) {
        setCookieEntries((prev) => prev.filter((entry) => entry.id !== id));
      }
    } catch {
    }
  }

  async function handleClearCookies() {
    try {
      const removed = await clearCookieJar(null, null);
      if (removed > 0) {
        setCookieEntries([]);
      }
    } catch {
    }
  }

  return (
    <div className="thin-scrollbar flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden bg-[hsl(var(--sidebar))]/98 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.08),transparent_38%)] p-6 lg:p-7 [&_button]:!rounded-none [&_input]:!rounded-none [&_input]:!bg-transparent">
      <div className="mb-6 flex items-start gap-4">
        <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center border border-primary/35 bg-primary/12 text-primary shadow-sm shadow-primary/10">
          <Settings2 className="h-4.5 w-4.5" />
        </div>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">App Settings</h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground/75">Manage app preferences</p>
        </div>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border/25 pb-3">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveSettingsTab(tab)}
            className={`h-9 border px-3.5 text-[12px] transition-colors ${activeSettingsTab === tab ? "border-primary/45 bg-primary/12 font-medium text-foreground" : "border-border/30 bg-transparent text-muted-foreground hover:border-border/45 hover:text-foreground"}`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex w-full max-w-5xl flex-col gap-4">
        {activeSettingsTab === "Storage" ? (
          <>
          <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_10px_24px_hsl(var(--background)/0.28)]">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 text-foreground">
              <HardDrive className="h-4 w-4 text-primary" />
              <h3 className="text-[14px] font-semibold">Storage Path</h3>
            </div>
            <div className="border border-border/35 bg-transparent px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Active data root
            </div>
          </div>

          <div className="space-y-3.5">
            <div className="flex gap-2">
              <Input
                value={pathInput}
                onChange={(event) => {
                  setPathInput(event.target.value);
                  setPathError("");
                  setPathValidation(null);
                }}
                placeholder="Select storage folder"
                className="h-10 border-border/35 bg-background/35 text-[13px]"
              />
              <Button type="button" variant="outline" size="icon" className="h-10 w-10 border-border/45 bg-background/35" onClick={handleBrowse}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <Button type="button" variant="secondary" size="sm" className="h-8 border border-border/40 bg-background/35" onClick={handleValidate}>
                Validate Path
              </Button>
              {pathValidation ? (
                <span className={validationTone}>
                  {pathValidation.exists && pathValidation.isDirectory && pathValidation.writable
                    ? "Path looks valid"
                    : "Path is not valid"}
                </span>
              ) : null}
            </div>

            <div className="border border-border/35 bg-transparent px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Resolved path</div>
              <div className="mt-1 break-all font-mono text-[11px] text-foreground/90">{resolvedTargetPath || "-"}</div>
            </div>

            <div className="space-y-2 border border-border/35 bg-transparent p-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">When switching</div>
              <label className="flex items-center gap-2 text-[12px] text-foreground">
                <input
                  type="radio"
                  name="migration-mode"
                  checked={mode === "copy"}
                  onChange={() => setMode("copy")}
                  className="accent-primary"
                />
                Copy all existing data to new path
              </label>
              <label className="flex items-center gap-2 text-[12px] text-foreground">
                <input
                  type="radio"
                  name="migration-mode"
                  checked={mode === "fresh"}
                  onChange={() => setMode("fresh")}
                  className="accent-primary"
                />
                Start fresh at new path
              </label>
            </div>

            {isSamePath ? (
              <div className="border border-[hsl(var(--warning)/0.62)] bg-[hsl(var(--warning)/0.16)] px-2.5 py-2 text-[12px] font-semibold text-[hsl(var(--warning-ink))]">Selected path matches current storage path.</div>
            ) : null}
            {pathError ? <div className="border border-[hsl(var(--danger)/0.55)] bg-[hsl(var(--danger)/0.16)] px-2.5 py-2 text-[12px] font-medium text-[hsl(var(--danger))]">{pathError}</div> : null}

            <div className="flex items-center justify-between gap-4 border-t border-border/20 pt-3">
              <div className="text-[11px] text-muted-foreground min-w-0">
                Current: <span className="font-mono">{storagePath || "-"}</span>
              </div>
              <Button type="button" className="h-9 border border-primary/55 bg-primary px-5 text-primary-foreground hover:bg-primary/90" onClick={handleApplyPath} disabled={isSubmitting || !pathInput.trim()}>
                {isSubmitting ? "Applying..." : "Apply Path"}
              </Button>
            </div>
          </div>
          </Card>
        </>
      ) : null}

      {activeSettingsTab === "Keybindings" ? (
        <>
          <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_8px_20px_hsl(var(--background)/0.2)]">
            <div className="mb-4 flex items-center justify-between gap-2 text-foreground">
              <div className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-primary" />
                <h3 className="text-[14px] font-semibold">Keyboard Shortcuts</h3>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 border border-border/40 bg-background/35"
                onClick={handleResetAllShortcuts}
              >
                Reset all
              </Button>
            </div>

            <div className="space-y-4 text-[12px]">
              {Object.entries(keybindingSections).map(([sectionName, items]) => (
                <div key={sectionName} className="border border-border/25 bg-transparent p-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {sectionName}
                  </div>
                  <div className="grid gap-2">
                    {items.map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-2">
                        <div className="text-foreground">{item.label}</div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openShortcutEditor(item.id)}
                            className="h-8 min-w-[160px] border border-border/40 bg-background/35 px-2.5 text-center font-mono text-[11px] text-foreground transition-colors hover:border-border/60"
                            title="Edit shortcut"
                          >
                            {shortcutToDisplay(appSettings.keybindings?.[item.id] || "")}
                          </button>
                          <button
                            type="button"
                            className="h-8 border border-border/40 bg-background/20 px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                            onClick={() => handleResetSingleShortcut(item.id)}
                            title="Reset shortcut"
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      {activeSettingsTab === "Theme" ? (
        <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_8px_20px_hsl(var(--background)/0.2)]">
          <div className="mb-4 flex items-center justify-between gap-2 text-foreground">
            <div className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-primary" />
              <h3 className="text-[14px] font-semibold">Theme</h3>
            </div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
              Applied instantly
            </div>
          </div>

          <div className="space-y-4 text-[12px]">
            <div>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Light themes</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {lightThemes.map((item) => {
                  const selected = theme === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onThemeChange?.(item.id)}
                      className={`border p-3 text-left transition-colors ${selected ? "border-primary/55 bg-primary/12 text-foreground" : "border-border/35 bg-background/20 text-foreground hover:border-border/50"}`}
                    >
                      <div className="mb-2 grid h-8 grid-cols-3 overflow-hidden border border-border/30">
                        <span style={{ backgroundColor: item.preview?.bg }} />
                        <span style={{ backgroundColor: item.preview?.card }} />
                        <span style={{ backgroundColor: item.preview?.accent }} />
                      </div>
                      <div className="text-[12px] font-medium">{item.label}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Dark themes</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {darkThemes.map((item) => {
                  const selected = theme === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onThemeChange?.(item.id)}
                      className={`border p-3 text-left transition-colors ${selected ? "border-primary/55 bg-primary/12 text-foreground" : "border-border/35 bg-background/20 text-foreground hover:border-border/50"}`}
                    >
                      <div className="mb-2 grid h-8 grid-cols-3 overflow-hidden border border-border/30">
                        <span style={{ backgroundColor: item.preview?.bg }} />
                        <span style={{ backgroundColor: item.preview?.card }} />
                        <span style={{ backgroundColor: item.preview?.accent }} />
                      </div>
                      <div className="text-[12px] font-medium">{item.label}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {activeSettingsTab === "Proxy" ? (
        <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_10px_24px_hsl(var(--background)/0.28)]">
          <div className="mb-4 flex items-center justify-between gap-2 text-foreground">
            <h3 className="text-[14px] font-semibold">Network Proxy</h3>
            <div className="text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
              {appSettings.proxyEnabled ? "Enabled" : "Disabled"}
            </div>
          </div>

          <div className="grid gap-3 text-[12px]">
            <label className="inline-flex items-center gap-2 text-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={appSettings.proxyEnabled}
                onChange={(event) => updateSettingsPatch({ proxyEnabled: event.target.checked })}
              />
              Enable proxy
            </label>

            <div className="grid gap-2 lg:grid-cols-3">
              <div className="grid gap-1">
                <div className="text-muted-foreground">Proxy for HTTP</div>
                <Input
                  value={appSettings.proxyHttp}
                  onChange={(event) => setSettingsState((prev) => ({ ...prev, proxyHttp: event.target.value }))}
                  onBlur={(event) => updateSettingsPatch({ proxyHttp: event.target.value.trim() })}
                  placeholder="http://localhost:8005"
                  className="h-9 border-border/35 bg-background/35 text-[12px]"
                />
              </div>
              <div className="grid gap-1">
                <div className="text-muted-foreground">Proxy for HTTPS</div>
                <Input
                  value={appSettings.proxyHttps}
                  onChange={(event) => setSettingsState((prev) => ({ ...prev, proxyHttps: event.target.value }))}
                  onBlur={(event) => updateSettingsPatch({ proxyHttps: event.target.value.trim() })}
                  placeholder="http://localhost:8005"
                  className="h-9 border-border/35 bg-background/35 text-[12px]"
                />
              </div>
              <div className="grid gap-1">
                <div className="text-muted-foreground">No proxy</div>
                <Input
                  value={appSettings.noProxy}
                  onChange={(event) => setSettingsState((prev) => ({ ...prev, noProxy: event.target.value }))}
                  onBlur={(event) => updateSettingsPatch({ noProxy: event.target.value.trim() })}
                  placeholder="localhost,127.0.0.1"
                  className="h-9 border-border/35 bg-background/35 text-[12px]"
                />
              </div>
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              <div className="grid gap-1">
                <div className="text-muted-foreground">Proxy username</div>
                <Input
                  value={appSettings.proxyUsername}
                  onChange={(event) => setSettingsState((prev) => ({ ...prev, proxyUsername: event.target.value }))}
                  onBlur={(event) => updateSettingsPatch({ proxyUsername: event.target.value.trim() })}
                  placeholder="Optional"
                  className="h-9 border-border/35 bg-background/35 text-[12px]"
                />
              </div>
              <div className="grid gap-1">
                <div className="text-muted-foreground">Proxy password</div>
                <Input
                  type="password"
                  value={appSettings.proxyPassword}
                  onChange={(event) => setSettingsState((prev) => ({ ...prev, proxyPassword: event.target.value }))}
                  onBlur={(event) => updateSettingsPatch({ proxyPassword: event.target.value })}
                  placeholder="Optional"
                  className="h-9 border-border/35 bg-background/35 text-[12px]"
                />
              </div>
            </div>
          </div>
        </Card>
      ) : null}

        {activeSettingsTab === "Cookie Jar" ? (
          <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_8px_20px_hsl(var(--background)/0.2)]">
          <div className="mb-4 flex items-center justify-between gap-2 text-foreground">
            <div className="flex items-center gap-2">
              <Cookie className="h-4 w-4 text-primary" />
              <h3 className="text-[14px] font-semibold">Cookie Jar</h3>
            </div>
            <div className="text-[11px] text-muted-foreground">{cookieEntries.length} stored</div>
          </div>

          <div className="grid gap-2.5 text-[12px]">
            <div className="flex items-center gap-2">
              <Input
                value={cookieFilter}
                onChange={(event) => setCookieFilter(event.target.value)}
                placeholder="Filter by name/domain/path"
                className="h-9 border-border/35 bg-background/35 text-[12px]"
              />
              <Button type="button" variant="secondary" size="sm" className="h-9 border border-border/40 bg-background/35" onClick={reloadCookies}>
                Refresh
              </Button>
              <Button type="button" variant="secondary" size="sm" className="h-9 border border-border/40 bg-background/35" onClick={handleClearCookies}>
                Clear All
              </Button>
              <Button type="button" size="sm" className="h-9" onClick={openAddCookieModal}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add Cookie
              </Button>
            </div>

            <div className="max-h-[280px] thin-scrollbar overflow-auto border border-border/25 bg-transparent">
              {isCookieLoading ? (
                <div className="px-3 py-3 text-muted-foreground">Loading cookies...</div>
              ) : filteredCookies.length === 0 ? (
                <div className="px-3 py-3 text-muted-foreground">No cookies found.</div>
              ) : (
                filteredCookies.map((entry) => (
                  <div key={entry.id} className="grid grid-cols-[180px_minmax(0,1fr)_150px] items-center gap-2 border-b border-border/15 px-3 py-2 last:border-b-0">
                    <div className="truncate text-[11px] text-muted-foreground">{entry.domain || "-"}</div>
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-foreground">{entry.name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{entry.path}</div>
                      <div className="truncate text-[10px] text-muted-foreground/90">
                        {entry.secure ? "Secure" : "Insecure"} · {entry.httpOnly ? "HttpOnly" : "JS-readable"}
                        {entry.sameSite ? ` · SameSite=${entry.sameSite}` : ""}
                        {entry.expiresAt ? ` · Exp=${entry.expiresAt}` : " · Session"}
                        {entry.workspaceName ? ` · WS=${entry.workspaceName}` : ""}
                        {entry.collectionName ? ` · Col=${entry.collectionName}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-7 border border-border/40 bg-background/35 px-2 text-[11px]"
                        onClick={() => handleEditCookie(entry)}
                      >
                        Edit
                      </Button>
                      <button
                        type="button"
                        onClick={() => handleDeleteCookie(entry.id)}
                        className="inline-flex items-center justify-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-red-400"
                        title="Delete cookie"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          </Card>
      ) : null}

        {activeSettingsTab === "History" ? (
          <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_8px_20px_hsl(var(--background)/0.2)]">
            <div className="mb-4 flex items-center justify-between gap-2 text-foreground">
              <h3 className="text-[14px] font-semibold">Request History</h3>
              <Button type="button" variant="secondary" size="sm" className="h-8 border border-border/40 bg-background/35" onClick={onClearHistory}>
                Clear
              </Button>
            </div>
            <div className="thin-scrollbar max-h-[520px] overflow-auto border border-border/20">
              {requestHistory.length === 0 ? (
                <div className="p-4 text-[12px] text-muted-foreground">No requests sent yet.</div>
              ) : (
                requestHistory.map((entry) => (
                  <div key={entry.id || `${entry.sentAt}-${entry.url}`} className="grid grid-cols-[88px_minmax(0,1fr)_92px_120px] gap-3 border-b border-border/10 px-3 py-2 text-[12px]">
                    <div className={entry.ok ? "text-emerald-400" : "text-red-400"}>{entry.status || "ERR"}</div>
                    <div className="min-w-0">
                      <div className="truncate text-foreground">{entry.method} {entry.url}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{entry.workspaceName} / {entry.collectionName} / {entry.requestName}</div>
                      {entry.error ? <div className="truncate text-[11px] text-red-400">{entry.error}</div> : null}
                    </div>
                    <div className="text-muted-foreground">{entry.duration || "-"}</div>
                    <div className="text-right text-muted-foreground">{entry.sentAt ? new Date(entry.sentAt).toLocaleString() : "-"}</div>
                  </div>
                ))
              )}
            </div>
          </Card>
        ) : null}

        {activeSettingsTab === "Security" ? (
          <>
          <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_10px_24px_hsl(var(--background)/0.28)]">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 text-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <h3 className="text-[14px] font-semibold">Authentication Security</h3>
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
                {isSavingSettings ? "Saving..." : "Saved"}
              </div>
            </div>

            <div className="grid gap-2 text-[12px]">
              <label className="inline-flex items-center gap-2 text-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={appSettings.clearOAuthSessionOnStart}
                  onChange={(event) => updateSettingsPatch({ clearOAuthSessionOnStart: event.target.checked })}
                />
                Clear OAuth sessions on app start
              </label>

              <label className="inline-flex items-center gap-2 text-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={appSettings.validateCertificatesDuringAuthentication}
                  onChange={(event) => updateSettingsPatch({ validateCertificatesDuringAuthentication: event.target.checked })}
                />
                Validate certificates during authentication
              </label>

              <label className="inline-flex items-center gap-2 text-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={appSettings.storeLastResponseByDefault}
                  onChange={(event) => updateSettingsPatch({ storeLastResponseByDefault: event.target.checked })}
                />
                Store last response by default
              </label>
            </div>
          </Card>

          <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_10px_24px_hsl(var(--background)/0.28)]">
            <div className="mb-4 flex items-center gap-2 text-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h3 className="text-[14px] font-semibold">Certificate Trust</h3>
            </div>

            <div className="grid gap-2 text-[12px]">
              <label className="inline-flex items-center gap-2 text-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={appSettings.sslTlsCertificateVerification}
                  onChange={(event) => updateSettingsPatch({ sslTlsCertificateVerification: event.target.checked })}
                />
                SSL/TLS certificate verification for requests
              </label>

              <label className="inline-flex items-center gap-2 text-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={appSettings.useCustomCaCertificate}
                  onChange={(event) => updateSettingsPatch({ useCustomCaCertificate: event.target.checked })}
                />
                Use custom CA certificate
              </label>

              <div className="flex items-center gap-2 pl-6">
                <Button type="button" variant="secondary" size="sm" className="h-8 border border-border/40 bg-background/35" onClick={handleSelectCustomCaPath}>
                  Select file
                </Button>
                <Input
                  value={appSettings.customCaCertificatePath}
                  onChange={(event) => setSettingsState((prev) => ({ ...prev, customCaCertificatePath: event.target.value }))}
                  onBlur={(event) => updateSettingsPatch({ customCaCertificatePath: event.target.value.trim() })}
                  placeholder="Custom CA certificate path"
                  className="h-8 border-border/35 bg-background/35 text-[12px]"
                />
              </div>

              <label className="inline-flex items-center gap-2 pl-6 text-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked
                  disabled
                  readOnly
                />
                Keep default CA certificates
              </label>

              <label className="inline-flex items-center gap-2 pt-2 text-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={appSettings.useClientCertificate}
                  onChange={(event) => updateSettingsPatch({ useClientCertificate: event.target.checked })}
                />
                Use client certificate for mTLS
              </label>

              <div className="grid gap-2 pl-6 lg:grid-cols-2">
                <Input
                  value={appSettings.clientCertificatePath}
                  onChange={(event) => setSettingsState((prev) => ({ ...prev, clientCertificatePath: event.target.value }))}
                  onBlur={(event) => updateSettingsPatch({ clientCertificatePath: event.target.value.trim() })}
                  placeholder="Client certificate PEM path"
                  className="h-8 border-border/35 bg-background/35 text-[12px]"
                />
                <Input
                  value={appSettings.clientKeyPath}
                  onChange={(event) => setSettingsState((prev) => ({ ...prev, clientKeyPath: event.target.value }))}
                  onBlur={(event) => updateSettingsPatch({ clientKeyPath: event.target.value.trim() })}
                  placeholder="Client private key PEM path"
                  className="h-8 border-border/35 bg-background/35 text-[12px]"
                />
              </div>
            </div>
          </Card>
          </>
        ) : null}

        {activeSettingsTab === "Updates" ? (
          <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_8px_20px_hsl(var(--background)/0.2)]">
          <div className="mb-4 flex items-center justify-between gap-2 text-foreground">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-primary" />
              <h3 className="text-[14px] font-semibold">Software Update</h3>
            </div>
            <div className={`border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${statusTone}`}>
              {updaterStatus}
            </div>
          </div>

          <div className="space-y-3 text-[12px]">
            <div className="border border-border/30 bg-transparent px-3 py-2.5 text-muted-foreground">
              Current version: <span className="font-semibold text-foreground">v{appVersion}</span>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 border border-border/40 bg-background/35"
                onClick={() => window.dispatchEvent(new CustomEvent("manual-update-check"))}
                disabled={updaterStatus === "downloading"}
              >
                Check for Updates
              </Button>
              {updaterStatus === "available" ? (
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  onClick={() => window.dispatchEvent(new CustomEvent("manual-update-install"))}
                >
                  Restart to Update
                </Button>
              ) : null}
            </div>
          </div>

          </Card>
        ) : null}

        {activeSettingsTab === "Resources" ? (
          <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_8px_20px_hsl(var(--background)/0.2)]">
          <div className="mb-4 flex items-center gap-2 text-foreground">
            <BookOpen className="h-4 w-4 text-primary" />
            <h3 className="text-[14px] font-semibold">Resources & Support</h3>
          </div>

          <div className="grid gap-2.5 text-[12px]">
            <button
              type="button"
              onClick={() => handleOpenExternal("https://github.com/DevlogZz/Kivo/blob/main/CHANGELOG.md", "changelog")}
              className="flex items-center justify-between border border-border/35 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-background/20"
            >
              <span className="flex items-center gap-2 text-foreground"><BookOpen className="h-3.5 w-3.5 text-primary" />View Changelog</span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </button>

            <button
              type="button"
              onClick={() => handleOpenExternal("https://github.com/DevlogZz/Kivo/blob/main/LICENSE", "license")}
              className="flex items-center justify-between border border-border/35 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-background/20"
            >
              <span className="flex items-center gap-2 text-foreground"><FileText className="h-3.5 w-3.5 text-primary" />View License</span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </button>

            <button
              type="button"
              onClick={() => handleOpenExternal("https://github.com/DevlogZz/Kivo", "GitHub")}
              className="flex items-center justify-between border border-border/35 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-background/20"
            >
              <span className="flex items-center gap-2 text-foreground"><Star className="h-3.5 w-3.5 text-amber-400" />Give a Star on GitHub</span>
              <Github className="h-3.5 w-3.5 text-muted-foreground" />
            </button>

            <button
              type="button"
              onClick={() => handleOpenExternal("https://github.com/sponsors/DevlogZz", "sponsorship page")}
              className="flex items-center justify-between border border-border/35 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-background/20"
            >
              <span className="flex items-center gap-2 text-foreground"><Heart className="h-3.5 w-3.5 text-rose-400" />Sponsor this Project</span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </button>

            <button
              type="button"
              onClick={() => handleOpenExternal(reportIssueUrl, "issue form")}
              className="flex items-center justify-between border border-border/35 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-background/20"
            >
              <span className="flex items-center gap-2 text-foreground"><Siren className="h-3.5 w-3.5 text-orange-400" />Report Issue</span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </button>

            <button
              type="button"
              onClick={() => handleOpenExternal(featureRequestUrl, "feature request form")}
              className="flex items-center justify-between border border-border/35 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-background/20"
            >
              <span className="flex items-center gap-2 text-foreground"><Lightbulb className="h-3.5 w-3.5 text-cyan-400" />Request a Feature</span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
          </Card>
        ) : null}
      </div>

      {isCookieEditorOpen ? createPortal(
        <div className="fixed inset-0 z-[330] flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => event.target === event.currentTarget && closeCookieEditor()}>
          <Card className="w-full max-w-4xl rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-foreground">{cookieDraft.id ? "Edit Cookie" : "Add Cookie"}</h3>
              <button type="button" onClick={closeCookieEditor} className="text-muted-foreground transition-colors hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid gap-3 text-[12px]">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  value={cookieDraft.name}
                  onChange={(event) => setCookieDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Name (e.g. jwt)"
                  className="h-10 border-border/35 bg-background/35 text-[12px]"
                />
                <Input
                  value={cookieDraft.value}
                  onChange={(event) => setCookieDraft((prev) => ({ ...prev, value: event.target.value }))}
                  placeholder="Value"
                  className="h-10 border-border/35 bg-background/35 text-[12px]"
                />
                <Input
                  value={cookieDraft.domain}
                  onChange={(event) => setCookieDraft((prev) => ({ ...prev, domain: event.target.value }))}
                  placeholder="Domain (example.com)"
                  className="h-10 border-border/35 bg-background/35 text-[12px]"
                />
                <Input
                  value={cookieDraft.path}
                  onChange={(event) => setCookieDraft((prev) => ({ ...prev, path: event.target.value }))}
                  placeholder="Path"
                  className="h-10 border-border/35 bg-background/35 text-[12px]"
                />
                <Input
                  value={cookieDraft.workspaceName}
                  onChange={(event) => setCookieDraft((prev) => ({ ...prev, workspaceName: event.target.value }))}
                  placeholder="Workspace scope (optional)"
                  className="h-10 border-border/35 bg-background/35 text-[12px]"
                />
                <Input
                  value={cookieDraft.collectionName}
                  onChange={(event) => setCookieDraft((prev) => ({ ...prev, collectionName: event.target.value }))}
                  placeholder="Collection scope (optional)"
                  className="h-10 border-border/35 bg-background/35 text-[12px]"
                />
              </div>

              <div className="grid grid-cols-[1fr_150px_auto_auto] items-center gap-3">
                <Input
                  value={cookieDraft.expiresAt}
                  onChange={(event) => setCookieDraft((prev) => ({ ...prev, expiresAt: event.target.value }))}
                  placeholder="Expires At (RFC3339 or HTTP date, optional)"
                  className="h-10 border-border/35 bg-background/35 text-[12px]"
                />
                <Input
                  value={cookieDraft.sameSite}
                  onChange={(event) => setCookieDraft((prev) => ({ ...prev, sameSite: event.target.value }))}
                  placeholder="SameSite"
                  className="h-10 border-border/35 bg-background/35 text-[12px]"
                />
                <label className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                  <input type="checkbox" className="accent-primary" checked={cookieDraft.secure} onChange={(event) => setCookieDraft((prev) => ({ ...prev, secure: event.target.checked }))} />
                  Secure
                </label>
                <label className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                  <input type="checkbox" className="accent-primary" checked={cookieDraft.httpOnly} onChange={(event) => setCookieDraft((prev) => ({ ...prev, httpOnly: event.target.checked }))} />
                  HttpOnly
                </label>
              </div>

              <div className="flex items-center justify-between pt-2">
                <label className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                  <input type="checkbox" className="accent-primary" checked={cookieDraft.hostOnly} onChange={(event) => setCookieDraft((prev) => ({ ...prev, hostOnly: event.target.checked }))} />
                  Host-only domain
                </label>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" className="h-9 border border-border/40 bg-background/35" onClick={resetCookieDraft}>
                    Reset
                  </Button>
                  <Button type="button" size="sm" className="h-9" onClick={handleSaveCookie} disabled={isSavingCookie}>
                    {isSavingCookie ? "Saving..." : cookieDraft.id ? "Update Cookie" : "Save Cookie"}
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>,
        document.body
      ) : null}

      {editingShortcutAction ? createPortal(
        <div
          className="fixed inset-0 z-[340] flex items-center justify-center bg-black/70 p-4"
          onMouseDown={(event) => event.target === event.currentTarget && closeShortcutEditor()}
        >
          <Card className="w-full max-w-2xl rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-foreground">Edit Shortcut</h3>
              <button type="button" onClick={closeShortcutEditor} className="text-muted-foreground transition-colors hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mb-2 text-[12px] text-muted-foreground">{editingShortcutAction.label}</div>
            <div className="text-[12px] text-muted-foreground">Press desired key combination and then press ENTER.</div>
            <button
              type="button"
              className="mt-3 h-11 w-full border border-border/40 bg-background/35 px-3 text-center font-mono text-[13px] text-foreground"
              onKeyDown={handleShortcutEditorKeyDown}
              onClick={(event) => event.currentTarget.focus()}
              autoFocus
            >
              {shortcutToDisplay(shortcutDraft)}
            </button>
            {shortcutError ? (
              <div className="mt-2 text-[12px] text-red-400">{shortcutError}</div>
            ) : null}
          </Card>
        </div>,
        document.body
      ) : null}
    </div>
  );
}
