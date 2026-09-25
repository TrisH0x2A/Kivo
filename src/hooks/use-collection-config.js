import { useCallback, useEffect, useState } from "react";

import { getCollectionConfigSnapshot, saveCollectionConfig } from "@/lib/http-client.js";
import { createDefaultAuthState, normalizeAuthState } from "@/lib/oauth.js";

const DEFAULT_CONFIG = {
  defaultHeaders: [],
  defaultAuth: createDefaultAuthState(),
  scripts: { preRequest: "", postResponse: "" },
  mockServer: { port: 0, routes: [] },
};

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeConfig(base, local, remote, path = "", conflicts = []) {
  if (equalValue(local, base)) return { value: remote, conflicts };
  if (equalValue(remote, base)) return { value: local, conflicts };
  if (local && remote && base && typeof local === "object" && typeof remote === "object" && typeof base === "object" && !Array.isArray(local) && !Array.isArray(remote) && !Array.isArray(base)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    const value = {};
    for (const key of keys) {
      const result = mergeConfig(base[key], local[key], remote[key], path ? `${path}.${key}` : key, conflicts);
      value[key] = result.value;
    }
    return { value, conflicts };
  }
  conflicts.push(path || "config");
  return { value: local, conflicts };
}

export function useCollectionConfig(workspaceName, collectionName) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState(DEFAULT_CONFIG);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [revision, setRevision] = useState("");
  const [conflict, setConflict] = useState(null);

  const load = useCallback(async () => {
    if (!workspaceName || !collectionName) {
      setConfig(DEFAULT_CONFIG);
      setSavedConfig(DEFAULT_CONFIG);
      setRevision("");
      setConflict(null);
      setIsDirty(false);
      return;
    }
    setIsLoading(true);
    try {
      const snapshot = await getCollectionConfigSnapshot(workspaceName, collectionName);
      const result = snapshot.config;
      const normalized = {
        defaultHeaders: result.defaultHeaders ?? [],
        defaultAuth: normalizeAuthState(result.defaultAuth),
        scripts: result.scripts ?? { preRequest: "", postResponse: "" },
        mockServer: result.mockServer ?? { port: 0, routes: [] },
      };
      setConfig(normalized);
      setSavedConfig(normalized);
      setRevision(snapshot.revision || "");
      setConflict(null);
      setIsDirty(false);
    } catch (e) {
      console.error("useCollectionConfig: failed to load", e);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceName, collectionName]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!workspaceName || !collectionName || !isDirty || isLoading) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      save(config).catch((error) => {
        console.error("useCollectionConfig: autosave failed", error);
      });
    }, 700);

    return () => window.clearTimeout(timer);
  }, [workspaceName, collectionName, config, isDirty, isLoading]);

  async function save(overrideConfig) {
    const toSave = overrideConfig || config;
    try {
      const nextRevision = await saveCollectionConfig(workspaceName, collectionName, toSave, revision);
      setSavedConfig(toSave);
      setRevision(nextRevision || revision);
      setConflict(null);
      if (overrideConfig) {
        setConfig(toSave);
      }
      setIsDirty(false);
    } catch (e) {
      if (String(e?.message || e).startsWith("KIVO_EXTERNAL_CHANGE:")) {
        try {
          const snapshot = await getCollectionConfigSnapshot(workspaceName, collectionName);
          const remote = {
            defaultHeaders: snapshot.config.defaultHeaders ?? [],
            defaultAuth: normalizeAuthState(snapshot.config.defaultAuth),
            scripts: snapshot.config.scripts ?? { preRequest: "", postResponse: "" },
            mockServer: snapshot.config.mockServer ?? { port: 0, routes: [] },
          };
          const merged = mergeConfig(savedConfig, toSave, remote);
          setConflict({ local: toSave, remote, merged: merged.value, conflicts: merged.conflicts, revision: snapshot.revision });
          setIsDirty(false);
        } catch (reloadError) { console.error("useCollectionConfig: conflict reload failed", reloadError); }
      } else {
        console.error("useCollectionConfig: failed to save", e);
      }
      throw e;
    }
  }

  function updateConfig(updater) {
    setConfig((prev) => {
      const next = typeof updater === "function" ? updater(prev) : { ...prev, ...updater };
      setIsDirty(true);
      return next;
    });
  }

  function reset() {
    setConfig(savedConfig);
    setConflict(null);
    setIsDirty(false);
  }

  function resolveConflict(choice) {
    if (!conflict) return;
    const next = choice === "remote" ? conflict.remote : choice === "merge" ? conflict.merged : conflict.local;
    setConfig(next);
    setSavedConfig(conflict.remote);
    setRevision(conflict.revision);
    setConflict(null);
    setIsDirty(choice !== "remote");
  }

  return { config, isDirty, isLoading, conflict, updateConfig, save, reset, resolveConflict };
}

export { mergeConfig };
