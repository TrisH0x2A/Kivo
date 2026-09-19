import { useState, useRef, useEffect } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils.js";

const MAX_INLINE = 5;

export function RequestTabBar({ tabs, activeTab, onTabChange }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const needsOverflow = tabs.length > MAX_INLINE;
  const mainTabs = needsOverflow ? tabs.slice(0, MAX_INLINE) : tabs;
  const overflowTabs = needsOverflow ? tabs.slice(MAX_INLINE) : [];
  const isOverflowActive = overflowTabs.includes(activeTab);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="kivo-editor-tabs border-b px-3 text-[12px] text-muted-foreground">
      <div className="flex items-center gap-1">
        {mainTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => onTabChange(tab)}
            aria-pressed={activeTab === tab}
            className={cn(
              "kivo-editor-tab whitespace-nowrap px-2.5 text-muted-foreground transition-colors hover:text-foreground",
              activeTab === tab && "kivo-tab-active"
            )}
          >
            {tab}
          </button>
        ))}

        {overflowTabs.length > 0 && (
          <div ref={menuRef} className="relative ml-auto">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              title="More request sections"
              aria-label="More request sections"
              aria-expanded={menuOpen}
              className={cn(
                "flex items-center gap-1 whitespace-nowrap px-2 py-1 text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground lg:px-3 lg:py-1.5",
                isOverflowActive && "kivo-tab-active"
              )}
            >
              {isOverflowActive && <span>{activeTab}</span>}
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>

            {menuOpen && (
              <div className="kivo-glass absolute right-0 top-full z-50 mt-1 min-w-[130px] py-1 shadow-2xl">
                {overflowTabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      onTabChange(tab);
                      setMenuOpen(false);
                    }}
                    className={cn(
                      "block w-full px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
                      activeTab === tab && "bg-muted/30 text-foreground"
                    )}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
