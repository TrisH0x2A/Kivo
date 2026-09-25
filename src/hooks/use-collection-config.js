import { useCallback, useEffect, useState } from "react";

import { getCollectionConfig, saveCollectionConfig } from "@/lib/http-client.js";
import { createDefaultAuthState, normalizeAuthState } from "@/lib/oauth.js";

const DEFAULT_CONFIG = {
  defaultHeaders: [],
  defaultAuth: createDefaultAuthState(),
  scripts: { preRequest: "", postResponse: "" },
  mockServer: { port: 0, routes: [] },
};

export function useCollectionConfig(workspaceName, collectionName) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState(DEFAULT_CONFIG);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceName || !collectionName) {
      setConfig(DEFAULT_CONFIG);
      setSavedConfig(DEFAULT_CONFIG);
      setIsDirty(false);
      return;
    }
    setIsLoading(true);
    try {
      const result = await getCollectionConfig(workspaceName, collectionName);
      const normalized = {
        defaultHeaders: result.defaultHeaders ?? [],
        defaultAuth: normalizeAuthState(result.defaultAuth),
        scripts: result.scripts ?? { preRequest: "", postResponse: "" },
        mockServer: result.mockServer ?? { port: 0, routes: [] },
      };
      setConfig(normalized);
      setSavedConfig(normalized);
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
      await saveCollectionConfig(workspaceName, collectionName, toSave);
      setSavedConfig(toSave);
      if (overrideConfig) {
        setConfig(toSave);
      }
      setIsDirty(false);
    } catch (e) {
      console.error("useCollectionConfig: failed to save", e);
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
    setIsDirty(false);
  }

  return { config, isDirty, isLoading, updateConfig, save, reset };
}
