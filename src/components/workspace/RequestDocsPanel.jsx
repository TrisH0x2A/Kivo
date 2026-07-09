import { Braces, FileJson2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { buildMockFromRequest, buildOpenApiOperation, buildRequestJsonSchema, formatDesignBlock } from "@/lib/api-design.js";

function appendBlock(current, block) {
  const prefix = String(current || "").trim();
  return prefix ? `${prefix}\n\n${block}` : block;
}

export function RequestDocsPanel({ request, onChange }) {
  const schema = buildRequestJsonSchema(request);
  const mock = buildMockFromRequest(request);
  const operation = buildOpenApiOperation(request);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] px-3 py-3">
      <div className="flex min-h-0 flex-wrap items-center justify-between gap-2 border-b border-border/20 pb-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Notes</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-[11px]"
            onClick={() => onChange("docs", appendBlock(request.docs, formatDesignBlock("OpenAPI Operation", operation)))}
          >
            <FileJson2 className="h-3 w-3" />
            OpenAPI
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-[11px]"
            onClick={() => schema && onChange("docs", appendBlock(request.docs, formatDesignBlock("JSON Schema", schema)))}
            disabled={!schema}
          >
            <Braces className="h-3 w-3" />
            Schema
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-[11px]"
            onClick={() => mock && onChange("docs", appendBlock(request.docs, formatDesignBlock("Mock Response", mock)))}
            disabled={!mock}
          >
            <Sparkles className="h-3 w-3" />
            Mock
          </Button>
        </div>
      </div>
      <textarea
        className="thin-scrollbar min-h-0 flex-1 resize-none border-0 bg-transparent p-3 text-[12px] leading-5 text-foreground outline-none"
        value={request.docs}
        onChange={(event) => onChange("docs", event.target.value)}
        placeholder="Request notes, examples, reminders..."
      />
    </div>
  );
}
