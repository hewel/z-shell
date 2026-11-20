import { renderShell } from "@hewel/zgui";
import { ShellPanels } from "./panels/ShellPanels.tsx";
import { createShellStore, ShellProvider } from "./store.ts";
import { BarPopups } from "./surfaces/BarPopups.tsx";
import { StatusBar } from "./surfaces/StatusBar.tsx";
import { WallpaperLayer } from "./surfaces/WallpaperLayer.tsx";

function ShellApp() {
  const store = createShellStore();
  return (
    <ShellProvider value={store}>
      <WallpaperLayer />
      <StatusBar />
      <BarPopups />
      <ShellPanels />
    </ShellProvider>
  );
}

export const hostApiVersion = 1;

export function mount(): () => void {
  return renderShell(() => <ShellApp />);
}
