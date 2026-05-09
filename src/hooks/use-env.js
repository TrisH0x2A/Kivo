import { useCallback, useEffect, useState } from "react";

import { getEnvVars, saveEnvVars } from "@/lib/http-client.js";

const EMPTY = { workspace: [], collection: [], merged: {} };

export function useEnv(workspaceName, collectionName, workspaceEnvironmentId = null) {
  const [vars, setVars] = useState(EMPTY);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceName) {
      setVars(EMPTY);
      return;
    }
    setIsLoading(true);
    try {
      const result = await getEnvVars(workspaceName, collectionName || null, workspaceEnvironmentId || null);
      setVars(result);
    } catch (e) {
      console.error("useEnv: failed to load env vars", e);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceName, collectionName, workspaceEnvironmentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);


  async function saveVars(scope, orderedVars) {
    const colName = scope === "collection" ? (collectionName || null) : null;
    await saveEnvVars(workspaceName, colName, orderedVars, workspaceEnvironmentId || null);
    await refresh();
  }

  return { vars, isLoading, saveVars, refresh };
}
