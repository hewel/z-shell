# 运行时动态插件加载、显式全权信任边界与去中心化插件商店架构

**Status:** proposed

> _与 [ADR-0005](0005-toml-config-state-split-and-plugin-manifest.md)（静态构建期插件合成与整壳重打包）存在冲突并显式重开该部分：发行版打包用户环境中不具备本地 Bun 运行时与 `z-shell` 源码树，继续要求在内置插件商店启停或安装插件时重建整壳将导致终端不可用且变更脆弱。ADR-0005 确立的三层 TOML 状态分离（**User settings** `settings.toml` / **Durable state** `state.toml` / **Live state** 内存实时状态）、`plugin.toml` 单一事实源、`PluginId → EntryId → InstanceId` 配置作用域、以及永久禁止普通插件获取 `sessionLock` 的不变量继续完全有效。同时本 ADR 严格保持 [ADR-0001](0001-single-rust-daemon-and-ndjson-bus.md) 与 [ADR-0004](0004-cross-process-lock-and-idle-coordination.md) 对 **Host control channel**（`host-<display>.sock`）仅限 `zgui-js` 原生宿主独占的通道边界。_

为支撑 `z-shell` 插件生态与 `SettingsWindow` 内置插件商店的端到端落地（详见全景方案 [plugin-ecosystem-and-store-plan.md](../plugin-ecosystem-and-store-plan.md)），本决策将插件分发、运行与热生效模型从“构建期整壳静态合成”演进为**通用宿主校验的预构建 ESM（`.mjs`）+ 可选 Lightning CSS 运行时动态加载**，并配套**本机 QuickJS 字节码（`.qjsb`）按需编译缓存**、**显式全权信任与 `@hewel/zgui/shell-host` 防误用护栏**、以及**按显示会话隔离的三阶段世代切换（含跨世代 UI 状态接续）与防复活收窄回滚状态机**：

1. **分发产物格式与终端免 Bun 运行（同图校验本机 `.qjsb` 缓存）**：
   - 插件作者在发布构建阶段将插件预构建为 ES2022 `.mjs` 模块、可选预编译 Lightning CSS（`*.module.css` 自动按插件作用域哈希并禁止 `:root`/全局标签选择器/`.zshell-*`；纯行内样式 + `@z-shell/sdk/primitives` 的插件无需附带 `.css`）、可选 `.map` SourceMap 与静态资产，与声明式 `plugin.toml` 一同分发。发行版终端仅需预构建只读壳体资产、内置只读官方第一方插件种子目录与 Rust 原生二进制（`z-shelld`、`z-shell`、`zgui-host`），彻底摆脱本地 Bun 依赖。
   - 首期**严禁加载、分发或执行远端来源的 `.qjsb` 字节码**。`zgui-js` 的 `quickjs_abi_tag()` 强绑定 QuickJS-NG/rquickjs 提交与目标架构，且 `load_verified_bytecode_module` 内部包含 `unsafe { Module::load }`，接收远端字节码将显著扩大原生内存安全攻击面并造成跨版本/跨架构失效。
   - 改为由本机 `zgui-host` 通过通用参数（`--bytecode-cache-dir <dir>`）基于**同一份已通过内容摘要核验的内存模块图**按需编译 `.qjsb` 并写入 `$XDG_CACHE_HOME/z-shell/plugin-bytecode/`，缓存键严格绑定四要素：`(quickjs_abi_tag, canonical_module_name, module_sha256, resolved_import_graph_digest)`。任何缓存文件损坏、魔数/头字段不符或摘要不匹配时，必须直接丢弃缓存并安全回退至源码编译，绝不跳过校验进入 `Module::load`。

2. **通用 `zgui-js` 宿主边界、受控加载入口与完整共享 Solid 2 运行时 ABI**：
   - **保持 `zgui-js` 为通用运行时扩展宿主**：`zgui-host` 仅理解通用的 `--extensions-overlay <path>`、`--bytecode-cache-dir <dir>`、通用虚拟模块命名空间 `zgui-ext://<ext_id>/<rel_path>`、通用 `overlay_id`、`rollback_allowed_extensions`、锁屏挂起合并槽位、`captureSessionHandoff` / `restoreSessionHandoff` 与 `beforeCommit` / `onSessionCommitted` 钩子。`z-shell` 独占 `daemon_instance_id`、`desired_revision`、撤销判定、干净子集重算以及壳体 JS 通过 **Host control channel** 上报的六元组生效回执逻辑，绝不向 `zgui-js` 泄露 `z-shell` 领域语义。
   - 继续保留 `zgui-js` 构建校验器对普通业务代码动态 `import()` 必须使用静态字符串字面量的限制（`../zgui-js/packages/build/src/validate.ts`），不放宽任意动态路径导入。
   - 将特权原语（`SessionLockSurface`、`loadApprovedPluginEntry`、`listApprovedPluginEntries`）隔离至仅基础壳可导入的内部子路径 `@hewel/zgui/shell-host`，并将其排除在插件裸标识符外置白名单之外（由 `@z-shell/plugin-cli validate`、官方目录 CI 与 `CompositeVerifiedModuleProvider` 三层共同拦截）；`PluginHost` 通过 `@hewel/zgui/shell-host` 调用 `loadApprovedPluginEntry(entryId)`，并在宿主侧以通用复合闭图 `CompositeVerifiedModuleProvider` 解析壳体、共享运行时与已批准 **Plugin bundle** 的模块图。
   - 插件构建时将共享运行时外置至宿主共享运行时表，完整覆盖 10 个模块：`solid-js`、`@hewel/zgui`、`@hewel/zgui/renderer`、`@hewel/zgui/primitives`、`@hewel/zgui/jsx-runtime`、`@hewel/zgui-services`、`@z-shell/sdk`、`@z-shell/sdk/zgui`、`@z-shell/sdk/primitives` 与 `@z-shell/plugin-api`（明确排除面向外部 Bun 进程的 `@z-shell/sdk/bun` 以及基础壳独占的 `@hewel/zgui/shell-host`），保证壳体与所有壳内插件共享单一 Solid 2 响应式图与 `UiBridge`。
   - **双正交版本门禁（消除双轨硬门禁）**：`plugin.toml` 保留累加整数 `plugin_api`（检查 `plugin_api <= shell_max_plugin_api`：`1` 为旧静态形态、`2` 为运行时预构建形态）；`dist/manifest.build.json` 声明 `shared_runtime_abi` 为 `"<major>.<minor>"` 字符串（首期 `"1.0"`），采用向上兼容判定 `host.major == plugin.major && host.minor >= plugin.minor`（废弃脆弱的严格相等 `==`）；可选 `min_shell_version` 仅作为商店展示提示，不作为第三道硬门禁。

3. **诚实的安全边界与严格通道独占（首期聚焦纯 ESM + CSS，暂缓外部二进制进程）**：
   - **壳内 UI 与同上下文服务（显式全权信任）**：鉴于 `apps/shell` 在单一 QuickJS Context 内同时持有 `sessionLock` 与 **Host control channel**（`host-<display>.sock`），同上下文运行的壳内插件与壳体共享同一信任域（类似 GNOME Shell / VS Code 扩展模型）。内置商店的授权确认弹窗必须如实明示“启用第三方插件即授予其与 `z-shell` 壳体同等的运行信任”，绝不承诺进程内沙箱隔离；`plugin.toml` 的 `[host_capabilities]` / `[bus_permissions]`、`sessionLock` 硬禁令以及 `@hewel/zgui/shell-host` 子路径隔离均诚实定位于声明式透明审计、按需最小化扩展宿主能力与防误用护栏。壳内渲染异常由 `@hewel/zgui` 真实导出的 `<Errored>` 边界隔离，但文档与提示必须明确：`<Errored>` 无法隔离共享的 64 MiB QuickJS 堆耗尽（OOM）、死循环或整会话原生崩溃。
   - **首期聚焦纯预构建 ESM + 可选 CSS（暂缓 `external_process` 打包二进制）**：为避免在无多架构分发矩阵（`x86_64`/`aarch64`）与真实 OS 沙箱前提下过早引入打包原生二进制的复杂度，首期插件商店仅支持纯预构建 ESM + 可选 CSS 的 `in_session` 入口。此前拟迁往外部进程的 `z-shell/theme-bridges` 服务继续以 `in_session` 运行，通过 Phase 0 对齐后的 `zgui-js` `files` 与 `unix_sockets` 能力完整落地；面向多架构原生二进制的 `external_process` 与基于 `bwrap`/Linux namespace 屏蔽 `host-<display>.sock` 的 OS 级沙箱均明确列为后续独立 ADR 演进方向。
   - **严格保持 `host-<display>.sock` 宿主独占与 `plugins.lock` 协调**：延续 ADR-0001 与 ADR-0004，`host-<display>.sock` 永远仅对 `zgui-host`（含壳内 `SettingsWindow` 商店操作与状态回执）开放；`z-shell plugin` CLI 绝不连接 `host-<display>.sock`，而是统一获取 `plugins.lock` `flock` 原子更新共享 **Plugin registry**（`registry.json` v2）并递增 `desired_revision`，由活跃 **Shell daemon**（`z-shelld`）监听注册表自动收敛各显示会话（CLI 可通过 **Public bus channel** 订阅只读 `plugins` **Topic** 观测收敛状态，或在无守护进程时如实报告 `pending_apply`）。

4. **全局期望态与按显示运行态分离、三阶段无缝换代与防复活收窄回滚**：
   - 共享 **Plugin registry**（`$XDG_STATE_HOME/z-shell/plugins/registry.json` v2）仅保存跨显示共享的期望意图（不可变 **Plugin bundle** 路径、来源身份、审批记录、启停与撤销意图）与单调递增的 `desired_revision`；**严禁将单显示故障隔离（`quarantine` / `candidate_batch_quarantined`）或锁屏挂起状态写回共享注册表**。每个 Wayland 显示会话维护独立的 **Display overlay**（`$XDG_RUNTIME_DIR/z-shell/plugins-overlay-<display>.json`）以及按显示隔离的运行态观测与崩溃循环守卫（`z-shelld` 内存 **Live state** + 可选按显示持久化 `$XDG_STATE_HOME/z-shell/plugins/runtime-<display>.json`）。
   - **保留 `PluginId → EntryId → InstanceId` 多实例模型**：`[bar.plugins]`（`left`/`center`/`right`/`hidden`）同时支持简写 `EntryId` 字符串（隐式映射为 `default` 单实例）与完整对象 `{ entry, instance, output?, settings? }`；`z-shelld` 在生成 **Display overlay** 时统一完成每插件/每入口/每 **Entry instance** 配置校验与 `secret = true` 脱敏并展开为 `entry_instances`，供 `PluginHost` 按实例渲染。
   - 壳体通过 **Host control channel** 上报的生效回执必须按六元组 `(display, daemon_instance_id, shell_build_id, ui_generation, desired_revision, overlay_id)` 核对，任何旧世代或旧 **Daemon instance** 的迟到回执一律拒收。
   - 明确区分三个生命周期状态：**已撤销（`revoked`）**（期望态已撤销审批并强制禁用）、**等待解锁卸载（`pending_unlock_unload`）**（撤销或停用发生在锁屏期间，目标已落盘但宿主为保障锁屏不中断而延后生效）、**宿主已停用（`host_unloaded`）**（宿主已成功切换世代并确认卸载）。
   - 锁屏期间（`ext_session_lock_v1` 激活或持有 **Sleep hold** 时），`zgui-host` 绝不中断或重建锁屏会话，而是将收到的 **Display overlay** 变更合并保留至单槽位最新目标队列；解锁完成后仅对最新目标触发换代。
   - **自动三阶段交接 + 跨世代 UI 状态接续**：每次启停或更新立即触发三阶段整会话换代（`G → G+1`），同时 `zgui-host` 提供通用内存态 `captureSessionHandoff` / `restoreSessionHandoff` 钩子（有界大小、仅正常换代传递、绝不落盘、崩溃/回滚时丢弃），使 `SettingsWindow` 在换代后原地恢复路由、商店页签与滚动位置，避免操作过程中窗口消失。鉴于 `zgui-js` 分阶段挂载仅延迟出站网络与 compute workers，三阶段交接严格执行：
     1. **阶段一（纯预检与无副作用准备）**：`zgui-host` 校验 **Plugin bundle**、可选 CSS、能力与 ABI，执行 `begin_staged_mount` 并挂载候选 UI 树，严禁运行插件 `service.setup()`；
     2. **阶段二（旧世代停用并交还 Bus 租约）**：`zgui-host` 触发旧世代 `G` 停用其壳内服务并关闭服务公共总线连接，促使 `z-shelld` 经 `retire_client` 自动释放旧世代全部 `plugin.*` 主题/命令/抑制器租约；
     3. **阶段三（确认租约归零后提交接管）**：`zgui-host` 执行 `commit_staged_mount()`（并恢复正常换代 UI 上下文），`G+1` 侧 `PluginHost` 确认前代租约已归零后再启动插件 `service.setup()` 并通过观察期。
   - **通用 `rollback_allowed_extensions` 防复活与权限收窄**：**Display overlay** 必须携带通用白名单 `rollback_allowed_extensions`（当前已批准且未撤销的扩展 ID 列表）。若候选世代失败且内存中的 `last_good` 包含任意不在 `rollback_allowed_extensions` 中的扩展，**`zgui-host` 严禁恢复 `last_good`**（既防止复活已撤销代码，也防止残留已撤销插件合并进旧包里的宿主权限），必须直接降级至无第三方插件的 **Safe base shell** 并上报失败，随后由 `z-shelld` 重算干净子集与最小有效宿主能力并下发新 **Display overlay**。当多插件批量变更失败且无法唯一归因到单个插件时，在按显示运行态中标记 `candidate_batch_quarantined`，绝不武断单独隔离无辜插件。

5. **禁止 v1 静默升权、内置官方只读种子源、显式更新绑定摘要、跨源硬拒与无损能力合并**：
   - 审批记录绑定 `(approved_source_identity, approved_digest, approved_capabilities)` 与不可变只读 **Plugin bundle**（`$XDG_STATE_HOME/z-shell/plugins/bundles/<plugin_id>/<digest>/`）。从 registry v1 迁移到 v2 时，**严禁将 v1 已有批准静默升级为 v2 全权信任**：所有历史已启用插件迁移后强制置为禁用（`migration_reapproval_required`），提示用户复审并保留旧 TS/TSX 源目录不动。
   - **第一方插件随发行版作为 `official` 本地种子/镜像打包**：4 个第一方参考插件（`nosleep`、`ai-usage`、`niri-overview`、`theme-bridges`）在发行版构建时预构建并只读安装至 `/usr/share/z-shell/bundled-plugins/`，作为 `official` **Catalog source** 的内置只读本地种子（与在线 `official` 目录共享同一 `catalog:official|...` `source_identity` 命名空间，严格核验 `content_digest`）。默认保持未启用，离线开箱即可在商店中一键审批启用，联网后可从在线 `official` 源无缝原地升级而不触发跨源冲突；发行版包升级更新 `/usr/share/z-shell/bundled-plugins/` 时绝不静默覆盖用户已钉死的 **Plugin bundle**，仅提示存在可用更新。
   - **禁止静默自动更新**：商店 UI 严格执行两阶段 `stage → commit` 并携带用户所见 `(expected_from_digest, expected_to_digest, expected_capabilities_hash)`；CLI `upgrade` / `upgrade --all` 在本地完成暂存后必须展示版本、前后摘要与能力 Diff 并交互确认 `[y/N]`（`--yes` 仅允许放行无扩权更新，任何能力扩张必须显式传入 `--approve-capabilities` 或逐项交互确认）；本地 `--path` 开发 `sync` 在无扩权时直接刷新不可变 **Plugin bundle** 并保持启用（且始终不修改用户源码目录）。
   - **跨源同名插件硬拒绝接管**：不同 `source_identity` 的同名 `PluginId` 一律硬拒绝覆盖或接管（返回 `SourceConflict`），必须先显式卸载旧源插件再从新源安装；卸载仅清理注册表索引、内部只读 **Plugin bundle** 与 `.qjsb` 缓存，**绝不删除 `--path` 本地源码目录**。
   - **逐来源无损能力合并与契约先行对齐**：放弃对 `NetworkCapabilities` 做整壳布尔“或”合并，改为在 `zgui-js` 层按来源条目（`originRules`）独立判定或过渡期冲突硬拒绝；授权弹窗展示本次变更对整壳实际新增的净宿主权限 `net_added_shell_capabilities`。开放 `network` / `files` / `sqlite` / `clipboard` 能力透出前，必须先行对齐 `../zgui-js/crates/zgui-host/src/package.rs` 与 `../zgui-js/schemas/package.schema.json`。

6. **去中心化多源静态目录、同名冲突治理、诚实徽章与全场景离线约束**：
   - 支持内置 `official` **Catalog source**（含只读本地种子 `/usr/share/z-shell/bundled-plugins/`）以及用户在 `settings.toml` 中通过 `[[plugins.sources]]` 声明的第三方静态目录、归档来源与 Git monorepo `subdir` 钉死（归档解压强制防 zip-slip 与 tar-bomb）。
   - **多源同名 `PluginId` 冲突策略**：商店发现页按 `PluginId` 聚合展示并默认突出最高优先级源，同时在卡片与详情页显式列出全部提供该 ID 的 **Catalog source** 供用户主动切换，绝不静默遮蔽官方或其他源；CLI `z-shell plugin install <id>` 在未指定 `--source` 且命中多个已启用源时拒绝猜测并报错要求显式 `--source <id>`。
   - 商店 UI 对官方目录条目如实展示**“官方目录收录”**与**“内容摘要匹配”**徽章，不冒充端到端作者密码学身份签名。
   - 全面遵守 `[general].offline_mode`：明确区分本地已核验只读 **Plugin bundle** / 内置官方本地种子命中（允许离线安装/恢复）、缓存未命中（明确拒绝联网并提示原因）、以及在线下载中途切换为离线模式时的立即中止与临时暂存区清理。

## 备选方案评估

- **继续沿用 ADR-0005，在内置商店内触发本地 Plugin composer 静态合成整壳**：已否决。发行版打包安装环境中通常没有 Bun 工具链与完整的 `z-shell` 源码仓，无法在终端机器上现场重打包整个壳体；且每次启停插件触发全量打包耗时高、失败面大。
- **通过插件目录直接分发预编译 `.qjsb` 字节码**：已否决。QuickJS 字节码强依赖具体引擎版本与 CPU 架构，跨版本升级即全部失效；更重要的是将不可信外部字节码送入 `unsafe { Module::load }` 会直接引入原生内存破坏风险。
- **首期在插件商店引入打包原生二进制的 `external_process`、拆双 `zgui-host` 或内建 `bwrap` OS 沙箱**：首期已否决 / 暂缓。将打包原生二进制纳入首期会强制 `catalog-v1.json` 膨胀为多架构/ABI 分发矩阵，而没有 OS 级命名空间隔离时同 UID 进程仍能接触 `host-<display>.sock`；同时拆分双原生宿主或强依赖 `bwrap` 会大幅抬升部署与锁屏协同复杂度。现阶段依托 Phase 0 对齐后的 `files` 与 `unix_sockets` 能力即可无阻塞承载 `z-shell/theme-bridges` 等服务，`external_process` 与 OS 沙箱留待后续独立 ADR 演进。
- **让 `zgui-host` 直接内建 `z-shell` 领域语义或允许 CLI 直连 `host-<display>.sock`**：已否决。前者会把 `daemon_instance_id`、撤销策略与总线协议耦合进通用宿主 `zgui-js`；后者会重开并破坏 ADR-0001/0004 对 **Host control channel** 仅限原生 UI 宿主独占的安全边界。
- **沿用单一全局 overlay 文件、共享注册表存单显示隔离态或简单布尔“或”能力合并**：已否决。单全局文件及回写 `quarantine` 至共享 `registry.json` 会在多 Wayland 显示会话并发时造成状态串扰与迟到回执误判；简单布尔“或”合并会让单个插件的私网/明文 HTTP 声明隐式放宽所有其他来源的安全边界。

## 架构后果

- **无 Bun 发行版交付与离线开箱体验**：终端部署解耦为只读预构建壳体资产包 + 内置只读官方第一方 **Plugin bundle** 种子 + Rust 原生二进制（`z-shelld`、`z-shell`、`zgui-host`），彻底零 Bun 依赖；借助本机内存同图 `.qjsb` 缓存保持接近预编译的冷启动与热切换速度。
- **跨仓清晰边界与协同演进**：`zgui-js` 与 `z-shell` 按 [plugin-ecosystem-and-store-plan.md](../plugin-ecosystem-and-store-plan.md) 规划的 Phase 0–Phase 5 推进跨仓契约对齐（`package.schema.json`、逐来源网络策略）、通用复合闭图提供器、`@hewel/zgui/shell-host` 受控加载与跨世代内存状态接续、`rollback_allowed_extensions` 与 **Safe base shell** 降级、`z-shelld` 插件协调器（`registry.json` v2 监听与 **Display overlay** 生成）以及 `SettingsWindow` 一等 `Plugins` 商店页。
- **工具链与领域文档平滑退场与同步**：现有 `packages/composer` 在 Phase 1–2 期间保留只读兼容直至新写入端完全就绪，随后退场并转型为面向插件作者的独立预构建与校验工具链（`@z-shell/plugin-cli` 与 `create-z-shell-plugin`）；`GLOSSARY.md` 已先行同步正交术语，`SCOPE.md` 与 `docs/plugin-manifest-v1.md` 将在对应实施阶段协同修订，避免双轨规范长期漂移。
