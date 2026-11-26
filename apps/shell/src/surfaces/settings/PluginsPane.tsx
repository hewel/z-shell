import { Button, For, Image, Show, TextField, createEffect, createMemo, createSignal, type Accessor, type NativeChild } from "@hewel/zgui";
import { M3CardAction, M3InteractiveCard, M3SegmentedControl } from "@z-shell/sdk/primitives";
import { useDaemonMedia, useTopic } from "@z-shell/sdk/zgui";
import type { MediaRef } from "@z-shell/sdk";
import { ShellIcon } from "../../icons.tsx";
import { useShellStore } from "../../store.ts";
import type {
  CatalogListItem,
  CatalogListResponse,
  PluginsTopicSnapshot,
  PublicPluginEntry,
  StoreCategory,
} from "../../topics.ts";
import { PluginDetailView } from "./PluginDetailView.tsx";
import {
  ApprovalReviewDialog,
  InstallCustomDialog,
  SourcesDialog,
  type ApprovalReviewRequest,
} from "./PluginDialogs.tsx";
import styles from "./PluginsPane.module.css";

const VIEW_MODES = [
  { id: "installed", label: "Installed", testId: "plugins-mode-installed" },
  { id: "discover", label: "Discover", testId: "plugins-mode-discover" },
] as const;

const CATEGORIES: readonly { readonly id: "all" | StoreCategory; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "widgets", label: "Widgets" },
  { id: "productivity", label: "Productivity" },
  { id: "system", label: "System" },
  { id: "appearance", label: "Appearance" },
  { id: "compositor", label: "Compositor" },
  { id: "launcher", label: "Launcher" },
];

interface PluginCardRow {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly statusLabel: string;
  readonly accentStatus: boolean;
  readonly icon: MediaRef | null;
}

function PluginCardIcon(props: { readonly media: Accessor<MediaRef | null> }): NativeChild {
  const { hostClient } = useShellStore();
  const { src } = useDaemonMedia(hostClient, props.media, { fetchCommand: "plugins.catalog.fetch-blob" });
  return (
    <box class={styles.cardIcon}>
      <Show when={src()} fallback={<ShellIcon name="extension" size={18} color="var(--color-primary)" />}>
        {url => <Image ariaHidden src={url()} class={styles.cardIconImage} />}
      </Show>
    </box>
  );
}

export function PluginsPane(props: {
  readonly selectedPluginId: Accessor<string | null>;
  readonly onSelectPlugin: (id: string | null) => void;
}): NativeChild {
  const { publicClient, settings, invokePublic, invokeHostResult, setPluginUpdatesCount } = useShellStore();
  // Lazy subscription: subscribed ONLY while PluginsPane is mounted so SHELL_SUBSCRIBED_TOPICS stays at 24.
  const pluginsTopic = useTopic<PluginsTopicSnapshot>(publicClient, "plugins");

  const [viewMode, setViewMode] = createSignal<"installed" | "discover">("installed");
  const [query, setQuery] = createSignal("");
  const [category, setCategory] = createSignal<"all" | StoreCategory>("all");
  const [catalog, setCatalog] = createSignal<CatalogListResponse | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  const [statusError, setStatusError] = createSignal<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = createSignal(false);
  const [installCustomOpen, setInstallCustomOpen] = createSignal(false);
  const [approvalReq, setApprovalReq] = createSignal<ApprovalReviewRequest | null>(null);

  const loadCatalog = async () => {
    const res = await invokePublic("plugins.catalog.list", {
      query: query().trim(),
      ...(category() !== "all" ? { category: category() } : {}),
      offset: 0,
      limit: 30,
    });
    const parsed = res?.data as CatalogListResponse | undefined;
    if (parsed) {
      setCatalog(parsed);
      setPluginUpdatesCount(parsed.items.filter(item => item.update_available).length);
    }
  };

  createEffect(
    () => [publicClient(), query(), category(), pluginsTopic.data()?.desired_revision, pluginsTopic.data()?.sources.length] as const,
    ([client]) => {
      if (client) void loadCatalog();
    },
  );

  const offlineMode = () => pluginsTopic.data()?.offline_mode ?? settings.data()?.general.offline_mode ?? false;

  const refreshCatalog = async () => {
    setRefreshing(true);
    setStatusError(null);
    const res = await invokeHostResult("plugins.catalog.refresh", {});
    setRefreshing(false);
    if (!res.ok) {
      setStatusError(res.error);
      return;
    }
    await loadCatalog();
  };

  const catalogById = createMemo(() => {
    const map = new Map<string, CatalogListItem>();
    for (const item of catalog()?.items ?? []) {
      map.set(item.id, item);
    }
    return map;
  });

  const installedById = createMemo(() => {
    const map = new Map<string, PublicPluginEntry>();
    for (const p of pluginsTopic.data()?.plugins ?? []) {
      map.set(p.id, p);
    }
    return map;
  });

  const cards = createMemo((): readonly PluginCardRow[] => {
    if (viewMode() === "installed") {
      const q = query().trim().toLowerCase();
      return (pluginsTopic.data()?.plugins ?? [])
        .filter(p => !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
        .map(p => {
          const catItem = catalogById().get(p.id);
          const statusLabel = p.revoked
            ? "Revoked"
            : !p.approved || p.migration_reapproval_required
              ? "Needs approval"
              : catItem?.update_available
                ? `Update v${catItem.latest_version}`
                : p.enabled
                  ? "Enabled"
                  : "Disabled";
          return {
            id: p.id,
            name: p.name,
            subtitle: `${p.id} · v${p.version}`,
            statusLabel,
            accentStatus: p.enabled && p.approved && !p.revoked,
            icon: catItem?.icon ?? null,
          };
        });
    }
    return (catalog()?.items ?? []).map(item => ({
      id: item.id,
      name: item.name,
      subtitle: `${item.id} · v${item.latest_version}`,
      statusLabel: item.installed ? (item.update_available ? "Update available" : "Installed") : item.category,
      accentStatus: Boolean(item.installed),
      icon: item.icon ?? null,
    }));
  });

  const cardRows = createMemo(() => {
    const list = cards();
    const rows: (readonly PluginCardRow[])[] = [];
    for (let i = 0; i < list.length; i += 2) {
      rows.push(list.slice(i, i + 2));
    }
    return rows;
  });

  const selectedTopicEntry = createMemo(() => {
    const id = props.selectedPluginId();
    return id ? installedById().get(id) ?? null : null;
  });

  return (
    <box testId="settings-plugins-root" class={styles.root}>
      <Show
        when={props.selectedPluginId()}
        fallback={
          <column testId="settings-plugins-pane" class={styles.pane}>
            <row class={styles.toolbar}>
              <M3SegmentedControl ariaLabel="Plugin store view" compact options={VIEW_MODES} value={viewMode()} onChange={setViewMode} />
              <row class={styles.toolbarActions}>
                <Button
                  testId="plugins-refresh-btn"
                  ariaLabel="Refresh catalogs"
                  disabled={refreshing() || offlineMode()}
                  onClick={() => void refreshCatalog()}
                  class={styles.toolbarButton}
                >
                  <ShellIcon name="refresh" size={14} color="var(--color-on-surface-variant)" />
                  <text>{refreshing() ? "Refreshing…" : "Refresh"}</text>
                </Button>
                <Button
                  testId="plugins-sources-btn"
                  ariaLabel="Configure catalog sources"
                  onClick={() => setSourcesOpen(true)}
                  class={styles.toolbarButton}
                >
                  <ShellIcon name="tune" size={14} color="var(--color-on-surface-variant)" />
                  <text>Sources</text>
                </Button>
                <Button
                  testId="plugins-install-custom-btn"
                  ariaLabel="Install from local path or Git"
                  onClick={() => setInstallCustomOpen(true)}
                  class={styles.toolbarButtonPrimary}
                >
                  <ShellIcon name="add" size={14} color="var(--color-on-primary-container)" />
                  <text>Local / Git</text>
                </Button>
              </row>
            </row>

            <row class={styles.searchRow}>
              <TextField
                testId="plugins-search-input"
                ariaLabel="Search plugins"
                placeholder="Search plugins by name or id…"
                value={query()}
                onInput={ev => setQuery(ev.value)}
                class={styles.searchInput}
              />
            </row>

            <Show when={viewMode() === "discover"}>
              <row class={styles.categoryRow}>
                <For each={CATEGORIES} keyed={c => c.id}>
                  {cat => {
                    const active = () => category() === cat().id;
                    return (
                      <Button
                        testId={`plugins-cat-${cat().id}`}
                        selected={active()}
                        data-active={active() ? "true" : "false"}
                        onClick={() => setCategory(cat().id)}
                        class={styles.categoryButton}
                      >
                        <text>{cat().label}</text>
                      </Button>
                    );
                  }}
                </For>
              </row>
            </Show>

            <Show when={pluginsTopic.data()}>
              {snap => (
                <row testId="plugins-runtime-banner" class={styles.runtimeBanner}>
                  <text class={styles.runtimeBannerText}>
                    {!snap().runtime_overlay_supported
                      ? `Pending apply · Desired rev ${snap().desired_revision} · Run \`bun run build:shell\` to compose/apply plugin code`
                      : `Desired rev ${snap().desired_revision} · Applied rev ${snap().applied_desired_revision ?? "—"}`}
                  </text>
                  <Show when={snap().offline_mode}>
                    <box class={styles.offlineBadge}>
                      <text class={styles.offlineBadgeText}>Offline</text>
                    </box>
                  </Show>
                </row>
              )}
            </Show>

            <Show when={statusError()}>
              {err => (
                <text class={styles.errorText}>{err()}</text>
              )}
            </Show>

            <column class={styles.cardList}>
              <For
                each={cardRows()}
                keyed={row => row.map(c => c.id).join("|")}
                fallback={
                  <column class={styles.emptyCard}>
                    <ShellIcon name="extension" size={24} color="var(--color-on-surface-variant)" />
                    <text class={styles.emptyTitle}>
                      {viewMode() === "installed" ? "No plugins installed" : "No catalog plugins match"}
                    </text>
                    <text class={styles.emptySubtitle}>
                      {viewMode() === "installed" ? "Switch to Discover or add a local / Git plugin." : "Try refreshing catalog sources or clearing filters."}
                    </text>
                  </column>
                }
              >
                {row => (
                  <row class={styles.cardRow}>
                    <For each={row()} keyed={card => card.id}>
                      {card => (
                        <M3InteractiveCard
                          layout="row"
                          testId={`plugin-card-${card().id}`}
                          actionTestId={`plugin-card-action-${card().id}`}
                          ariaLabel={`Inspect ${card().name}`}
                          onClick={() => props.onSelectPlugin(card().id)}
                          class={styles.pluginCard}
                        >
                          <PluginCardIcon media={() => card().icon} />
                          <column class={styles.cardTextGroup}>
                            <text class={styles.cardTitle}>{card().name}</text>
                            <text class={styles.cardSubtitle}>
                              {card().subtitle}
                            </text>
                          </column>
                          <M3CardAction class={styles.cardAction}>
                            <box
                              class={styles.statusBadge}
                              data-accent={card().accentStatus ? "true" : "false"}
                            >
                              <text class={styles.statusBadgeText}>
                                {card().statusLabel}
                              </text>
                            </box>
                          </M3CardAction>
                        </M3InteractiveCard>
                      )}
                    </For>
                    <Show when={row().length === 1}>
                      <box ariaHidden class={styles.spacer} />
                    </Show>
                  </row>
                )}
              </For>
            </column>
          </column>
        }
      >
        {selectedId => (
          <PluginDetailView
            pluginId={selectedId()}
            topicEntry={selectedTopicEntry()}
            runtimeOverlaySupported={pluginsTopic.data()?.runtime_overlay_supported ?? false}
            appliedDesiredRevision={pluginsTopic.data()?.applied_desired_revision ?? null}
            desiredRevision={pluginsTopic.data()?.desired_revision ?? 0}
            onBack={() => props.onSelectPlugin(null)}
            onRequestApproval={req => setApprovalReq(req)}
            onRefreshList={() => void loadCatalog()}
          />
        )}
      </Show>

      <Show when={sourcesOpen()}>
        <SourcesDialog onClose={() => setSourcesOpen(false)} onUpdated={() => void loadCatalog()} />
      </Show>
      <Show when={installCustomOpen()}>
        <InstallCustomDialog
          onClose={() => setInstallCustomOpen(false)}
          onStaged={req => {
            setInstallCustomOpen(false);
            setApprovalReq(req);
          }}
        />
      </Show>
      <Show when={approvalReq()}>
        {req => (
          <ApprovalReviewDialog
            request={req()}
            onClose={() => setApprovalReq(null)}
            onCompleted={() => void loadCatalog()}
          />
        )}
      </Show>
    </box>
  );
}
