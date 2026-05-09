import { useCallback, useEffect, useState } from "react";

import {
  createWorkspaceEnvironment,
  deleteWorkspaceEnvironment,
  getWorkspaceEnvironments,
  setActiveWorkspaceEnvironment,
} from "@/lib/http-client.js";

const EMPTY = { activeEnvironmentId: "default", environments: [{ id: "default", name: "Default" }] };

export function useWorkspaceEnvironments(workspaceName) {
  const [data, setData] = useState(EMPTY);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceName) {
      setData(EMPTY);
      return;
    }
    setIsLoading(true);
    try {
      const result = await getWorkspaceEnvironments(workspaceName);
      setData(result);
    } catch (error) {
      console.error("useWorkspaceEnvironments: failed to load", error);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function createEnvironment(name) {
    if (!workspaceName) return data;
    const result = await createWorkspaceEnvironment(workspaceName, name);
    setData(result);
    return result;
  }

  async function setActiveEnvironment(environmentId) {
    if (!workspaceName) return data;
    const result = await setActiveWorkspaceEnvironment(workspaceName, environmentId);
    setData(result);
    return result;
  }

  async function deleteEnvironment(environmentId) {
    if (!workspaceName) return data;
    const result = await deleteWorkspaceEnvironment(workspaceName, environmentId);
    setData(result);
    return result;
  }

  return {
    workspaceEnvironments: data,
    isWorkspaceEnvironmentsLoading: isLoading,
    refreshWorkspaceEnvironments: refresh,
    createEnvironment,
    setActiveEnvironment,
    deleteEnvironment,
  };
}
