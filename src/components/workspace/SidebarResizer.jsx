import { useRef } from "react";

export function SidebarResizer({ onMouseDown }) {
  const resizeRef = useRef({ active: false, startX: 0, startWidth: 304 });

  return (
    <div
      className="w-px shrink-0 cursor-col-resize bg-border/20 transition-colors hover:bg-primary/50"
      onMouseDown={(event) => {
        resizeRef.current = { active: true, startX: event.clientX, startWidth: resizeRef.current.startWidth };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        onMouseDown(event, resizeRef);
      }}
    />
  );
}
