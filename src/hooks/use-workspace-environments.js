import { useCallback, useEffect, useRef, useState } from "react";

import {
  createWorkspaceEnvironment,
  deleteWorkspaceEnvironment,
  getWorkspaceEnvironments,
  setActiveWorkspaceEnvironment,
} from "@/lib/http-client.js";

const EMPTY = { activeEnvironmentId: "default", environments: [{ id: "default", name: "Default" }] };
const CHANGE_EVENT = "kivo:workspace-environments-changed";

export function useWorkspaceEnvironments(workspaceName) {
  const [data, setData] = useState(EMPTY);
  const [isLoading, setIsLoading] = useState(false);
  const sequence = useRef(0);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    if (!workspaceName) {
      setData(EMPTY);
      setIsLoading(false);
      setError("");
      return;
    }
    setIsLoading(true);
    try {
      const result = await getWorkspaceEnvironments(workspaceName);
      if (current === sequence.current) { setData(result); setError(""); }
    } catch (error) {
      console.error("useWorkspaceEnvironments: failed to load", error);
      if (current === sequence.current) setError(String(error));
    } finally {
      if (current === sequence.current) setIsLoading(false);
    }
  }, [workspaceName]);

  useEffect(() => {
    setData(EMPTY);
    refresh();
    const onChange = (event) => { if (event.detail === workspaceName) refresh(); };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => { sequence.current++; window.removeEventListener(CHANGE_EVENT, onChange); };
  }, [refresh]);

  async function createEnvironment(name) {
    if (!workspaceName) return data;
    const result = await createWorkspaceEnvironment(workspaceName, name);
    setData(result);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: workspaceName }));
    return result;
  }

  async function setActiveEnvironment(environmentId) {
    if (!workspaceName) return data;
    const result = await setActiveWorkspaceEnvironment(workspaceName, environmentId);
    setData(result);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: workspaceName }));
    return result;
  }

  async function deleteEnvironment(environmentId) {
    if (!workspaceName) return data;
    const result = await deleteWorkspaceEnvironment(workspaceName, environmentId);
    setData(result);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: workspaceName }));
    return result;
  }

  return {
    workspaceEnvironments: data,
    isWorkspaceEnvironmentsLoading: isLoading,
    workspaceEnvironmentsError: error,
    refreshWorkspaceEnvironments: refresh,
    createEnvironment,
    setActiveEnvironment,
    deleteEnvironment,
  };
}
