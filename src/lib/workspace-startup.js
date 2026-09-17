export async function loadWorkspaceStartup({ readConfig, readState, normalize }) {
  const config = await readConfig();
  if (!config || typeof config !== "object") {
    throw new Error("Kivo returned an invalid storage configuration.");
  }
  if (!config.storagePath) return { needsSetup: true };

  const persisted = await readState();
  // Invalid input must never become an empty, autosavable workspace.
  if (!persisted || !Array.isArray(persisted.workspaces)) {
    throw new Error("Kivo returned an invalid workspace snapshot.");
  }
  return { needsSetup: false, store: normalize(persisted) };
}
