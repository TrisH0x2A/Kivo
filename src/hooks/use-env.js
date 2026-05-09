import { useCallback, useEffect, useRef, useState } from "react";

import { getEnvVars, saveEnvVars } from "@/lib/http-client.js";

const EMPTY = { workspace: [], collection: [], merged: {} };

export function useEnv(workspaceName, collectionName, workspaceEnvironmentId = null) {
  const [vars, setVars] = useState(EMPTY);
  const [isLoading, setIsLoading] = useState(false);
  const hasLoadedRef = useRef(false);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!workspaceName) {
      setVars(EMPTY);
      hasLoadedRef.current = false;
      setIsLoading(false);
      return;
    }

    if (!hasLoadedRef.current) {
      setIsLoading(true);
    }

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    try {
      const result = await getEnvVars(workspaceName, collectionName || null, workspaceEnvironmentId || null);
      if (requestSeq !== requestSeqRef.current) {
        return;
      }
      setVars(result);
      hasLoadedRef.current = true;
    } catch (e) {
      if (requestSeq !== requestSeqRef.current) {
        return;
      }
      console.error("useEnv: failed to load env vars", e);
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [workspaceName, collectionName, workspaceEnvironmentId]);

  useEffect(() => {
    hasLoadedRef.current = false;
  }, [workspaceName, collectionName]);

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
