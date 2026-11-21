import { renderShell } from "@hewel/zgui";
import { ShellPanels } from "./panels/ShellPanels.tsx";
import { PluginHost } from "./plugins/PluginHost.tsx";
import { createShellStore, ShellProvider } from "./store.ts";
import { BarPopups } from "./surfaces/BarPopups.tsx";
import { DockSurface } from "./surfaces/DockSurface.tsx";
import { KimpanelPopup } from "./surfaces/KimpanelPopup.tsx";
import { LauncherOverlay } from "./surfaces/LauncherOverlay.tsx";
import { NotificationToasts } from "./surfaces/NotificationToasts.tsx";
import { OsdOverlay } from "./surfaces/OsdOverlay.tsx";
import { OverviewOverlay } from "./surfaces/OverviewOverlay.tsx";
import { PolkitDialog } from "./surfaces/PolkitDialog.tsx";
import { PowerDialog } from "./surfaces/PowerDialog.tsx";
import { SessionLockOverlay } from "./surfaces/SessionLockOverlay.tsx";
import { SettingsWindow } from "./surfaces/SettingsWindow.tsx";
import { StatusBar } from "./surfaces/StatusBar.tsx";
import { WallpaperLayer } from "./surfaces/WallpaperLayer.tsx";
import { useShellTheme } from "./theme.ts";

function ShellApp() {
  const store = createShellStore();
  useShellTheme(store.theme.data);
  return (
    <ShellProvider value={store}>
      <PluginHost />
      <WallpaperLayer />
      <StatusBar />
      <DockSurface />
      <BarPopups />
      <ShellPanels />
      <NotificationToasts />
      <OsdOverlay />
      <KimpanelPopup />
      <LauncherOverlay />
      <OverviewOverlay />
      <PowerDialog />
      <PolkitDialog />
      <SettingsWindow />
      <SessionLockOverlay />
    </ShellProvider>
  );
}

export const hostApiVersion = 1;

export function mount(): () => void {
  return renderShell(() => <ShellApp />);
}
