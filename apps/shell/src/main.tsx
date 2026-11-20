import { renderShell } from "@hewel/zgui";
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
    </ShellProvider>
  );
}

export const hostApiVersion = 1;

export function mount(): () => void {
  return renderShell(() => <ShellApp />);
}
