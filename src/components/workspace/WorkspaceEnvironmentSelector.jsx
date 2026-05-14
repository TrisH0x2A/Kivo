import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";

export function WorkspaceEnvironmentSelector({
  environments = [],
  activeEnvironmentId = "default",
  isLoading = false,
  onSetActive,
  onCreate,
  onDelete,
}) {
  const [draftName, setDraftName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [switchingId, setSwitchingId] = useState("");
  const [deletingId, setDeletingId] = useState("");

  const activeName = useMemo(
    () => environments.find((env) => env.id === activeEnvironmentId)?.name || "Default",
    [activeEnvironmentId, environments]
  );

  async function handleCreate() {
    const name = draftName.trim();
    if (!name || !onCreate) return;
    setIsCreating(true);
    try {
      await onCreate(name);
      setDraftName("");
      toast.success(`Environment created: ${name}`);
    } catch (error) {
      toast.error(`Failed to create environment: ${String(error)}`);
    } finally {
      setIsCreating(false);
    }
  }

  const isAddDisabled =
    isLoading || isCreating || Boolean(switchingId) || Boolean(deletingId) || !draftName.trim();

  async function handleSetActive(environment) {
    if (!onSetActive || !environment?.id) return;
    if (environment.id === activeEnvironmentId) return;
    setSwitchingId(environment.id);
    try {
      await onSetActive(environment.id);
      toast.success(`Active environment: ${environment.name}`);
    } catch (error) {
      toast.error(`Failed to switch environment: ${String(error)}`);
    } finally {
      setSwitchingId("");
    }
  }

  async function handleDelete(environmentId) {
    if (!onDelete || !environmentId || environmentId === "default") return;
    const target = environments.find((env) => env.id === environmentId);
    const envName = target?.name || environmentId;
    const confirmed = window.confirm(`Delete environment "${envName}"? This removes its workspace variables file.`);
    if (!confirmed) return;
    setDeletingId(environmentId);
    try {
      await onDelete(environmentId);
      toast.success(`Environment deleted: ${envName}`);
    } catch (error) {
      toast.error(`Failed to delete environment: ${String(error)}`);
    } finally {
      setDeletingId("");
    }
  }

  return (
    <div className="border border-border/45 bg-card/35 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Workspace Environment
        </span>
        <span className="border border-border/35 bg-background/25 px-2 py-0.5 text-[11px] text-muted-foreground">Active: {activeName}</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {environments.map((env) => {
          const isActive = env.id === activeEnvironmentId;
          return (
            <div key={env.id} className="inline-flex min-h-8 items-center border border-border/40 bg-background/20">
              <button
                type="button"
                disabled={isLoading || isCreating || Boolean(deletingId) || Boolean(switchingId) || isActive}
                onClick={() => handleSetActive(env)}
                className={`max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap border-r border-border/25 px-2.5 py-1.5 text-[12px] transition-colors ${isActive ? "bg-primary/12 text-primary" : "text-foreground hover:bg-accent/40"}`}
              >
                {env.name}
              </button>
              {env.id !== "default" ? (
                <button
                  type="button"
                  disabled={isLoading || isCreating || Boolean(switchingId) || deletingId === env.id}
                  onClick={() => handleDelete(env.id)}
                  className="border-l border-border/30 px-2 py-1.5 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
                  title="Delete environment"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_98px] items-center gap-2">
        <Input
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          placeholder="Add environment (e.g. staging)"
          className="h-9 rounded-none border-border/45 bg-background/20 text-[12px]"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleCreate();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          className={`h-9 w-full justify-center gap-2 px-3 text-[12px] ${
            isAddDisabled
              ? "border border-border/45 bg-background/20 font-medium text-muted-foreground"
              : "border border-primary/55 bg-primary text-primary-foreground font-semibold"
          }`}
          onClick={handleCreate}
          disabled={isAddDisabled}
        >
          <Plus className="h-3.5 w-3.5" /> {isCreating ? "Adding..." : "Add"}
        </Button>
      </div>
    </div>
  );
}
