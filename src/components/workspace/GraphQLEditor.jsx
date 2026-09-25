import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, RefreshCw, ShieldCheck, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { CodeEditor } from "@/components/workspace/CodeEditor.jsx";
import { formatJsonText } from "@/lib/formatters.js";
import { formatGraphqlQuery, graphqlCompletions, graphqlDiagnostics, introspectionQuery, parseGraphqlSchema, schemaFromIntrospection } from "@/lib/graphql-tools.js";
import { buildRequestPayload } from "@/lib/http-ui.js";
import { cancelHttpRequest, sendHttpRequest } from "@/lib/http-client.js";

export function GraphQLEditor({ query, variables, onQueryChange, onVariablesChange, disabled, request, onChange, workspaceName, collectionName }) {
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const fileRef = useRef(null);
  const activeRequest = useRef(null);
  const mounted = useRef(true);
  const schema = useMemo(() => { try { return parseGraphqlSchema(request?.contract?.graphqlSchema); } catch { return null; } }, [request?.contract?.graphqlSchema]);
  useEffect(() => { setNotice(""); }, [query]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (activeRequest.current) cancelHttpRequest(activeRequest.current).catch(() => {}); };
  }, []);
  function saveSchema(sdl) {
    parseGraphqlSchema(sdl);
    onChange("contract", { ...request.contract, graphqlSchema: sdl });
    setNotice("Schema ready");
  }
  async function introspect() {
    const requestId = `schema-${crypto.randomUUID()}`;
    activeRequest.current = requestId;
    setLoading(true); setNotice("");
    try {
      const payload = buildRequestPayload({ ...request, method: "POST", bodyType: "graphql", body: introspectionQuery, graphqlVariables: "{}", timeoutMs: 15000 }, workspaceName, collectionName);
      const result = await sendHttpRequest({ ...payload, requestId });
      if (result.status < 200 || result.status >= 300) throw new Error(`Introspection returned HTTP ${result.status}`);
      if (mounted.current) saveSchema(schemaFromIntrospection(result.body));
    } catch (error) { if (mounted.current) setNotice(String(error.message || error)); }
    finally { activeRequest.current = null; if (mounted.current) setLoading(false); }
  }
  function handleFormatQuery() {
    try { onQueryChange(formatGraphqlQuery(query)); setNotice(""); } catch (error) { setNotice(error.message); }
  }

  function handleFormatVariables() {
    try {
      onVariablesChange(formatJsonText(variables || "{}"));
    } catch {
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,2fr)_auto_minmax(0,1fr)] overflow-hidden bg-transparent">
      <div className="border-b border-border/20 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button className="gap-2" size="sm" variant="ghost" onClick={introspect} disabled={disabled || loading || !request?.url}><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />{loading ? "Loading schema..." : "Introspect"}</Button>
          <Button className="gap-2" size="sm" variant="ghost" onClick={() => fileRef.current?.click()} disabled={loading}><FileUp className="h-3.5 w-3.5" />Import SDL</Button>
          <Button className="gap-2" size="sm" variant="ghost" disabled={!schema} onClick={() => { const errors = graphqlDiagnostics(schema, query); setNotice(errors.length ? errors.join("\n") : "Query matches schema"); }}><ShieldCheck className="h-3.5 w-3.5" />Validate query</Button>
          <input ref={fileRef} type="file" accept=".graphql,.gql,.txt" className="hidden" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { if (file.size > 2_000_000) throw new Error("Schema exceeds 2 MB."); const sdl = await file.text(); if (mounted.current) saveSchema(sdl); } catch (error) { if (mounted.current) setNotice(error.message); } }} />
        </div>
        {notice && <div role="status" className="max-h-24 overflow-auto whitespace-pre-wrap break-words px-2 pt-2 text-xs text-muted-foreground">{notice}</div>}
      </div>
      <EditorSection title="Query" actionLabel="Format Query" onFormat={handleFormatQuery} disabled={disabled}>
        <CodeEditor
          value={query}
          onChange={onQueryChange}
          placeholder={"query GetUsers {\n  users {\n    id\n    name\n  }\n}"}
          language="graphql"
          getAutocompleteItems={schema ? (source, cursor) => graphqlCompletions(schema, source, cursor) : undefined}
          disabled={disabled}
        />
      </EditorSection>

      <div className="h-px bg-border/12" />

      <EditorSection title="Variables" actionLabel="Format Variables" onFormat={handleFormatVariables} disabled={disabled}>
        <CodeEditor
          value={variables}
          onChange={onVariablesChange}
          placeholder={"{\n  \"id\": 1\n}"}
          language="json"
          disabled={disabled}
        />
      </EditorSection>
    </div>
  );
}

function EditorSection({ title, actionLabel, onFormat, disabled, children }) {
  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex items-center justify-between border-b border-border/12 px-3 py-2 text-[11px] text-muted-foreground lg:text-[12px]">
        <span className="font-medium text-foreground">{title}</span>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-[11px]" onClick={onFormat} disabled={disabled}>
          <Wand2 className="h-3 w-3" />
          {actionLabel}
        </Button>
      </div>
      {children}
    </div>
  );
}
