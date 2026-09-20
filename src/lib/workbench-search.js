export function searchWorkbench(workspaces, query = "") {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const workspace of workspaces) {
    for (const collection of workspace.collections || []) {
      const scope = { workspaceName: workspace.name, collectionName: collection.name };
      const collectionText = `${workspace.name} ${collection.name}`.toLowerCase();
      if (terms.every((term) => collectionText.includes(term))) {
        results.push({ ...scope, kind: "collection", label: collection.name, detail: workspace.name });
      }
      for (const request of collection.requests || []) {
        const searchText = `${collectionText} ${request.name} ${request.method} ${request.requestMode} ${request.url} ${request.grpcMethodPath || ""}`.toLowerCase();
        if (terms.every((term) => searchText.includes(term))) {
          results.push({ ...scope, kind: "request", requestName: request.name, label: request.name, detail: `${workspace.name} / ${collection.name}`, method: request.requestMode === "http" ? request.method : request.requestMode });
        }
      }
    }
  }
  return results;
}
