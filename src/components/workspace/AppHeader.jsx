import { Github, Sparkles } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { ThemeToggle } from "@/components/workspace/ThemeToggle.jsx";
import { useTheme } from "@/hooks/use-theme.js";

export function AppHeader({ workspaceTitle, workspaceDescription }) {
  const { theme, toggleTheme } = useTheme();
  const version = "0.4.1";

  return (
    <Card className="flex items-center justify-between gap-4 border-0 border-b border-border/30 bg-card/55 px-3 py-2.5 shadow-none">
      <div className="flex items-center gap-3 min-w-0">
        <div className="hidden h-8 w-8 items-center justify-center bg-primary/12 text-primary sm:flex">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground lg:text-[12px]">{workspaceTitle}</p>
          <h1 className="truncate mt-0.5 text-[13px] font-semibold tracking-tight text-foreground lg:text-[15px]">{workspaceDescription}</h1>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="mr-1 text-[10px] font-medium text-muted-foreground lg:text-[11px]">v{version}</span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 rounded-sm border-border/40 bg-card/40 px-2.5 text-[11px] text-foreground"
          onClick={() => openUrl("https://github.com/TrisH0x2A/Kivo")}
        >
          <Github className="h-3.5 w-3.5" />
          <span className="leading-none">GitHub</span>
        </Button>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>
    </Card>
  );
}
