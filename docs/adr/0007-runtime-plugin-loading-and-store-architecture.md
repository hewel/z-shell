# 运行时动态插件加载、显式全权信任边界与去中心化插件商店架构

**Status:** proposed

> _与 [ADR-0005](0005-toml-config-state-split-and-plugin-manifest.md)（静态构建期插件合成与整壳重打包）存在冲突并显式重开该部分：发行版打包用户环境中不具备本地 Bun 运行时与 `z-shell` 源码树，继续要求在内置插件商店启停或安装插件时重建整壳将导致终端不可用且变更脆弱。ADR-0005 确立的三层 TOML 状态分离（**User settings** `settings.toml` / **Durable state** `state.toml` / **Live state** 内存实时状态）、`plugin.toml` 单一事实源、`PluginId → EntryId → InstanceId` 配置作用域、以及永久禁止普通插件获取 `sessionLock` 的不变量继续完全有效。_

为支撑 `z-shell` 插件生态与 `SettingsWindow` 内置插件商店的端到端落地（详见全景方案 [plugin-ecosystem-and-store-plan.md](../plugin-ecosystem-and-store-plan.md)），本决策将插件分发、运行与热生效模型从“构建期整壳静态合成”演进为**宿主校验的预构建 ESM（`.mjs`）+ Lightning CSS 运行时动态加载**，并配套**本机 QuickJS 字节码（`.qjsb`）按需编译缓存**、**显式全权信任与按入口执行边界**、以及**按显示会话隔离的三阶段世代切换与防复活回滚状态机**：

1. **分发产物格式与终端免 Bun 运行（同图校验本机 `.qjsb` 缓存）**：
   - 插件作者在发布构建阶段将插件预构建为 ES2022 `.mjs` 模块、预编译 Lightning CSS（`.css`）、可选 `.map` SourceMap 与静态资产，与声明式 `plugin.toml` 一同分发。发行版终端仅需预构建只读壳体资产与 Rust 原生二进制（`z-shelld`、`z-shell`、`zgui-host`），彻底摆脱本地 Bun 依赖。
   - 首期**严禁加载、分发或执行远端来源的 `.qjsb` 字节码**。`zgui-js` 的 `quickjs_abi_tag()` 强绑定 QuickJS-NG/rquickjs 提交与目标架构，且 `load_verified_bytecode_module` 内部包含 `unsafe { Module::load }`，接收远端字节码将显著扩大原生内存安全攻击面并造成跨版本/跨架构失效。
   - 改为由本机 `zgui-host` 基于**同一份已通过内容摘要核验的内存模块图**按需编译 `.qjsb` 并写入 `$XDG_CACHE_HOME/z-shell/plugin-bytecode/`，缓存键严格绑定四要素：`(quickjs_abi_tag, canonical_module_name, module_sha256, resolved_import_graph_digest)`。任何缓存文件损坏、魔数/头字段不符或摘要不匹配时，必须直接丢弃缓存并安全回退至源码编译，绝不跳过校验进入 `Module::load`。

2. **受控宿主加载入口与完整共享 Solid 2 运行时 ABI**：
   - 继续保留 `zgui-js` 构建校验器对普通业务代码动态 `import()` 必须使用静态字符串字面量的限制（`../zgui-js/packages/build/src/validate.ts`），不放宽任意动态路径导入。
   - 由 `zgui-host` 提供仅接受宿主已批准 `entryId` 的受控原生加载接口（如内部经 `@hewel/zgui` 封装暴露给 `PluginHost` 的 `loadApprovedPluginEntry(entryId)`），并在宿主侧以复合闭图 `VerifiedModuleProvider` 解析壳体与已批准插件的模块图。
   - 插件构建时将共享运行时外置至宿主共享运行时表，完整覆盖 `solid-js`、`@hewel/zgui`、`@hewel/zgui/renderer`、`@hewel/zgui/primitives`、`@hewel/zgui/jsx-runtime`、`@hewel/zgui-services`、`@z-shell/sdk`、`@z-shell/sdk/zgui`、`@z-shell/sdk/primitives` 与 `@z-shell/plugin-api`（明确排除仅面向外部 Bun 进程的 `@z-shell/sdk/bun`），保证壳体与所有壳内插件共享单一 Solid 2 响应式图与 `UiBridge`。

3. **诚实的安全边界与按入口执行契约**：
   - **壳内 UI 与同上下文服务（显式全权信任）**：鉴于 `apps/shell` 在单一 QuickJS Context 内同时持有 `sessionLock` 与 **Host control channel**（`host-<display>.sock`），同上下文运行的壳内插件与壳体共享同一信任域（类似 GNOME Shell / VS Code 扩展模型）。内置商店的授权确认弹窗必须如实明示“启用第三方插件即授予其与 `z-shell` 壳体同等的运行信任”，绝不承诺进程内沙箱隔离；`plugin.toml` 的 `[host_capabilities]` / `[bus_permissions]` 与 `sessionLock` 硬禁令明确定位为声明式透明审计、按需最小化扩展宿主能力与防误用护栏。壳内渲染异常由 `@hewel/zgui` 真实导出的 `<Errored>` 边界隔离，但文档与提示必须明确：`<Errored>` 无法隔离共享的 64 MiB QuickJS 堆耗尽（OOM）、死循环或整会话原生崩溃。
   - **按入口声明的同 UID 受信外部进程（故障与堆隔离，非 OS 沙箱）**：在 **Plugin entry** 级（首期针对 `[[service]]`）支持 `execution = "in_session" | "external_process"`，允许同一 **Plugin** 混合包含外部后台进程服务与壳内 `settings_page`/`widget`/`panel`。鉴于 `z-shell-bus`（`SO_PEERCRED`）仅校验同 Unix UID，首期 `external_process` 明确界定为同 UID 受信后台进程，用于隔离 64 MiB QuickJS 堆上限、崩溃故障域与外部运行时依赖；由 **Shell daemon**（`z-shelld`）按显示会话监督其固定不可变快照可执行文件、静态 `argv`、最小环境变量（显式不注入 `host-<display>.sock` 路径）、就绪探测、崩溃退避与停用/卸载时的进程组零残余回收。真正的 OS 级沙箱（如 `bwrap` / 独立 mount namespace 屏蔽特权套接字与敏感目录）列为后续演进方向，不纳入首期路线图。

4. **全局期望态与按显示会话运行态分离、三阶段交接与防复活回滚**：
   - 共享注册表 `$XDG_STATE_HOME/z-shell/plugins/registry.json`（v2）仅保存跨显示共享的期望意图（安装快照、审批记录、启停意图）与单调递增的 `desired_revision`；每个 Wayland 显示会话维护独立的运行时叠加文件 `$XDG_RUNTIME_DIR/z-shell/plugins-overlay-<display>.json` 与内存态会话观测状态。宿主回报的生效回执必须按六元组 `(display, daemon_instance_id, shell_build_id, ui_generation, desired_revision, overlay_id)` 核对，任何旧世代或跨实例的迟到回执一律拒收。
   - 明确区分三个生命周期状态：**已撤销（`revoked`）**（期望态已撤销审批并强制禁用）、**等待解锁卸载（`pending_unlock_unload`）**（撤销或停用发生在锁屏期间，目标已落盘但宿主为保障锁屏不中断而延后生效）、**宿主已停用（`host_unloaded`）**（宿主已成功切换世代并确认卸载）。
   - 锁屏期间（`ext_session_lock_v1` 激活或持有 **Sleep hold** 时），`zgui-host` 绝不中断或重建锁屏会话，而是将收到的 overlay 变更挂起并合并为仅保留最新期望目标；解锁完成后仅执行最新目标。**执行任何故障回滚前，必须先依据当前已批准且未撤销集合重新筛选 `last_good`**，严禁回滚操作复活已被用户撤销的插件；若重过滤后的 `last_good` 为空或仍加载失败，直接降级至无第三方插件基础壳（Safe Base Shell）。
   - 鉴于 `zgui-js` 的分阶段挂载（`begin_staged_mount` / `commit_staged_mount`）仅延迟出站网络与 compute workers，无法自动撤销插件通过 **Bus** 建立的 `plugin.*` 主题/命令注册或抑制器租约，世代切换严格遵循三阶段交接：
     1. **阶段一（纯预检与无副作用准备）**：校验模块、CSS、能力与快照摘要并挂载候选 UI 树，严禁运行插件 `service.setup()`；
     2. **阶段二（旧世代交还租约）**：旧会话停用其壳内服务与连接，向 `z-shelld` 完整释放所有 `plugin.*` 主题/命令/抑制器租约；
     3. **阶段三（新世代提交并接管）**：候选会话执行 `commit_staged_mount()` 后再启动插件 `service.setup()` 并通过观察期。
   - 当一次批量叠加变更（多插件同时启用或更新）在预检或观察期失败且无法唯一归因到单个插件时，隔离该候选变更组合并回滚至经重过滤的 `last_good`，绝不武断将无辜插件单独标记为故障隔离。

5. **禁止 v1 静默升权、显式更新绑定摘要、跨源硬拒接管与逐来源无损能力合并**：
   - 审批记录绑定 `(approved_source_identity, approved_digest, approved_capabilities)` 与只读不可变快照目录。从 registry v1 迁移到 v2 时，**严禁将 v1 的已有批准静默升级为 v2 的全权信任**：所有历史已启用插件迁移后必须强制置为禁用（`migration_reapproval_required`），提示用户复审并保留旧 TS/TSX 源目录不动，避免静默扩权或破坏既有开发环境。
   - **禁止静默自动更新**：用户通过内置商店点击「更新」或通过 CLI 执行 `z-shell plugin upgrade` / `sync` 时，命令负载必须携带用户界面所见的确切 `(expected_from_digest, expected_to_digest)`；若来源未变且能力未扩张，用户此次显式更新操作即视为对新不可变快照的批准并保持启用；若声明能力发生任何扩张或来源元数据异常，必须强制禁用并展示完整能力 Diff 进行二次确认。
   - **跨源同名插件硬拒绝接管**：已安装某 `PluginId` 后，不同来源标识（`source_identity` 不同）的同名包一律拒绝覆盖或接管；用户必须先显式卸载旧插件再从新源安装。卸载操作仅清理注册表记录、内部只读快照与缓存，**绝不删除用户本地 `--path` 指向的源码目录**。
   - **逐来源无损能力合并与契约先行对齐**：放弃对 `NetworkCapabilities` 做整壳简单布尔“或”合并（避免单个插件请求 `allow_private_networks` 或 `allow_insecure_http` 污染其他已批准插件的公网/HTTPS 源），改为在 `zgui-js` 层按来源条目携带独立策略或在无法无损表达时显式冲突拒绝；并在授权弹窗中向用户明确呈现本次变更对整壳实际新增的净宿主能力。开放 `network` / `files` / `sqlite` / `clipboard` 能力透出前，必须先行对齐 `../zgui-js/crates/zgui-host/src/package.rs` 与 `../zgui-js/schemas/package.schema.json`。

6. **去中心化多源静态目录、诚实徽章与全场景离线约束**：
   - 内置官方静态目录索引，同时支持用户在 `settings.toml` 中通过 `[[plugins.sources]]` 声明第三方静态目录、归档来源与 Git monorepo `subdir` 钉死（归档解压强制防 zip-slip 与 tar-bomb）。
   - 商店 UI 对官方目录条目如实展示**“官方目录收录”**与**“内容摘要匹配”**徽章，不冒充端到端作者密码学身份签名（未来引入作者签名后另行递增徽章等级）。
   - 全面遵守 `[general].offline_mode`：明确区分本地已核验只读快照缓存命中（允许离线安装/恢复）、缓存未命中（明确拒绝联网并提示原因）、以及在线下载中途切换为离线模式时的立即中止与临时暂存区清理。

## 备选方案评估

- **继续沿用 ADR-0005，在内置商店内触发本地 Plugin composer 静态合成整壳**：已否决。发行版打包安装环境中通常没有 Bun 工具链与完整的 `z-shell` 源码仓，无法在终端机器上现场重打包整个壳体；且每次启停插件触发全量打包耗时高、失败面大。
- **通过插件目录直接分发预编译 `.qjsb` 字节码**：已否决。QuickJS 字节码强依赖具体引擎版本与 CPU 架构，跨版本升级即全部失效；更重要的是将不可信外部字节码送入 `unsafe { Module::load }` 会直接引入原生内存破坏风险。
- **首期拆分双 `zgui-host` 特权进程或内建 `bwrap`/namespace OS 沙箱**：首期已否决。将锁屏、Polkit、设置页与常规桌面 UI 拆分为双原生宿主会大幅抬升跨进程 Wayland 合成、焦点与锁屏协同复杂度；而在首期引入强依赖发行版内核配置的 `bwrap` 沙箱会显著提高部署与排障门槛。两者均保留为长期演进路径，当前以诚实的显式全权信任模型与同 UID 故障隔离进程为基线。
- **沿用单一全局 overlay 文件与简单能力并集（布尔或）**：已否决。单全局文件在多 Wayland 显示会话并发时会造成状态串扰与迟到回执误判；简单布尔或合并会让单个插件的私网/明文 HTTP 声明隐式放宽所有其他来源的安全边界。

## 架构后果

- **无 Bun 发行版交付**：终端部署解耦为只读预构建壳体资产包 + Rust 原生二进制（`z-shelld`、`z-shell`、`zgui-host`），不再要求终端环境安装 Bun 或克隆源码仓；借助本机内存同图 `.qjsb` 缓存保持接近预编译的冷启动与热切换速度。
- **跨仓协同演进**：`zgui-js` 与 `z-shell` 需按 [plugin-ecosystem-and-store-plan.md](../plugin-ecosystem-and-store-plan.md) 规划的 Phase 0–Phase 5 推进跨仓契约对齐（`package.schema.json`、逐来源网络策略）、复合闭图模块提供器与受控加载入口、锁屏延迟与重过滤回滚、三阶段世代交接、`z-shelld` 插件协调器与 `SettingsWindow` 一等 `Plugins` 商店页。
- **工具链与领域文档平滑退场与同步**：现有 `packages/composer` 在 Phase 1–2 期间保留只读兼容直至新写入端完全就绪，随后退场并转型为面向插件作者的独立预构建与校验工具链（`@z-shell/plugin-cli` 与 `create-z-shell-plugin`）；`GLOSSARY.md`、`SCOPE.md` 与 `docs/plugin-manifest-v1.md` 将在对应实施阶段同步修订，避免双轨规范长期漂移。
