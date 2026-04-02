import { usePanelStore } from "../../stores/panelStore";
import { useShallow } from "zustand/react/shallow";
import PanelFrame from "./PanelFrame";

export default function LeftPanelContainer() {
  const panels = usePanelStore(useShallow((s) => s.panels.filter((p) => p.isOpen)));

  if (panels.length === 0) return null;

  return (
    <>
      {panels.map((panel) => (
        <PanelFrame key={panel.id} panel={panel} />
      ))}
    </>
  );
}
