# 用 RootBeer 验证通用 API hook

本案例验证公共 API hook 对原检测结果的影响，遵循
[Detection Intervention Contract](../../CLAUDE.md#detection-intervention-contract)。
案例适配器只定位控件、观察和读取结果；干预由公共模块负责。

## 运行

在仓库根目录执行，设备使用 API 33 x86_64 和锁定的 Frida 17.9.1：

```powershell
npm ci
npm run case:rootbeer -- --apk "D:\work_app\telegram\RootBeer Sample_0.9_APKPure.apk" --serial emulator-5554 --reuse-detect-env
```

Mac ARM64 lane 显式传 `--abi arm64-v8a`；本地省略 `--abi` 仍默认 x86_64。
server 必须匹配 schema-2 toolchain lock 中选定架构的哈希，固定 RootBeer APK
也必须包含该 ABI 的 native 库。两个架构各自保留本次 API 调用、结果和恢复证据；
下面的历史 x86_64 对照表不代表 ARM64 已通过。

`--reuse-detect-env` 要求已安装本项目的
`com.detect.app.sample`，用于证明同一脚本可以跨 APK 复用；省略该参数只执行 RootBeer 验收。工具和 server 准备方法见
[Frida README](../../README.md#general-runtime-smoke)。

runner 自动构建公共 API
bundle 一次，两个 APK 使用完全相同的公共字节和正负配置。每个目标把各自只读 UI 适配器附在公共 bundle 后，共用一个 Script 和 Java
bridge，避免两份 bridge 在安装、撤销 ART 补丁时相互影响；完整注入脚本的哈希也单独记录。它安装/覆盖安装固定 RootBeer
APK，保留数据，操作选定测试设备上的两个应用。APK 签名冲突直接报错，不卸载应用或清空数据。

## CI 与预构建产物

CI 从本仓库测试 Release `frida-fixtures-rootbeer-0.9` 下载
`rootbeer-sample-0.9.apk`，按照案例声明的 SHA256 校验。样本不设为 Latest；
APK 不进入源码，下载失败或校验不符会使 CI 失败。

`build:prod` 同时构建公共 `dist/android-api.js`，现有生产 manifest 将它与主 bundle、
Node CLI 一起校验。Runner 支持：

| 参数 | 含义 |
| --- | --- |
| `--agent <js>`、`--production-manifest <json>` | 必须成对提供；先验证完整生产产物及传入脚本的字节，之后才能操作设备 |
| `--output <directory>` | 指定本次结果目录；已存在则拒绝覆盖 |
| `--abi x86_64\|arm64-v8a` | 选择锁定 server、设备和 APK native ABI；默认 x86_64 |

预构建模式只编译只读 UI 适配器，公共 hook 不重新构建。
结果中的 `agentSource` 为 `production-artifact`，保存 manifest 快照和实际注入哈希。
未提供生产参数时继续自动构建，`agentSource` 为 `local-build`。
相对路径按进程当前目录解析；`npm run ...` 的当前目录是 `frida`。

API33 job 在同一模拟器中先执行四个基础回归，再强制运行本案例及 detect-env 复用。
案例输出写入该次 API33 结果目录的 `rootbeer` 子目录。统一报告要求案例结果存在、
Host 判定通过、使用生产产物且开启了复用；基础探针成功本身不能通过完整 CI。

独立的 Mac job 执行相同验收并保留 Ubuntu lane。其 runner/SDK/AVD 隔离、
清理与产物命名见 [Mac runner 运维说明](../../docs/MACOS_RUNNER.md)。

## 实验与验收

1. **observe**：APK 自己执行检测，记录 API、参数、原返回、Java 调用栈或 native 调用模块。
2. **positive**：加载
   `positive.json`，构造 su 文件存在、native 可读、ro.debuggable=1。
3. **negative**：加载
   `negative.json`，构造不存在、native 不可读、ro.debuggable=0，并设置 release-keys 等相关输入。
4. **restored**：切回纯观察，原检测结果和 Build.TAGS 回到基线。
5. **cold**：卸载脚本、冷启动，再以纯观察复核 RootBeer。

每次卸载后还通过系统输入连续两次重新检测，使用 UIAutomator 读取原界面，确认同一进程存活且结果恢复基线。清理 RPC 成功本身不能证明撤销安全。

所有检测由 **ADB 系统输入点击原界面控件**
触发。适配器只返回控件坐标、读取原结果列表和实际显示文本。不能用脚本中调用检测方法的返回代替实际 APK 覆盖。
detect-env 适配器先等待窗口获得焦点、可见检测行连续稳定，再返回一次系统点击的坐标，避免启动画面退出期间输入被丢弃。

这次发现直接从 Frida 回调调用 performClick 会使 detect-env 的 native 路径缺失于观测，改用系统输入后才观察到正常的 JNI
→ libc
fopen 调用。因此保留系统输入路径，不在 agent 中直接调用检测方法或检测入口。

原界面 12 项都被记录；以下是 API33 x86_64 上已获得的对照记录，当前结果以本次运行产物为准：

| 原检测项              | observe（当前设备） | positive | negative | restored / cold |
| --------------------- | ------------------- | -------- | -------- | --------------- |
| TestKeys              | true                | true     | false    | true            |
| Dangerous Props       | true                | true     | false    | true            |
| SU Binary             | false               | true     | false    | false           |
| Root via native check | false               | true     | false    | false           |
| 其余 8 项             | false               | false    | false    | false           |

JNI 检测接收的是 APK 原来扫描的真实路径列表。公共 fopen hook 按配置把
`/system/xbin/su` 访问引到 `/proc/self/status`
或不存在的 proc 路径，由原 JNI 函数自行产生检测结果，未直接修改其返回值。

第二 APK 通过自己的 sensitive-files 界面验证：Java 文件检查和 C/NDK 文件检查均得到“未检出 → 检出 → 未检出 → 恢复”。当前 C 路径实际使用 fopen；不能根据未调用的 C++
helper 推断它使用 access。直接 syscall 一项保持原结果，明确不属于本次覆盖。

Host 同时检查 API 来源、构造值、对应 APK 结果、非目标文件/属性、丢失记录、错误和恢复。只有 hook 命中、API 安装成功或自己调用 API 的 probe，均不能单独通过验收。

## 文件与输出

- 公共实现：`packages/modules/android-runtime-bypass/api-hooks.ts`；
  `npm run build:api` 产物为 `dist/android-api.js`。
- `agent.ts` 和 `detect-env-observer.ts`：仅观察界面、定位控件、读取显示结果。
- `positive.json` / `negative.json`：普通 API 值配置，没有目标类名或 JNI 名称。
- `run.mjs`：注入同一个公共脚本，驱动真实 UI，管理生命周期。
- `result.mjs`：Host 侧解释与验证结果。

输出位于 `.runtime/cases/rootbeer/<本次运行目录>`：
`result.json`、`report.md`、`events.jsonl`、`run.log`、各阶段原界面截图、公共脚本及只读适配器构建产物。API
bundle
SHA256 在两个目标上逐一记录并比较。成功返回 0，缺项、错误、无实际影响、恢复失败或复用证据不完整时返回非 0。

固定 RootBeer：包名 `com.scottyab.rootbeer.sample`、版本 0.9 / 10，SHA256
`cf1ad3c3c7f5dff2da91f72527b7756b658dc711408359173606cfce5fe08f0f`。
detect-env 使用本次构建并已安装核验的 APK，实际 SHA256 记录于
`result.json.reuse.apkSha256`，不绑定某个本地 Debug APK 的哈希。
检测清单和真实 native 调用由本地源码、实际 APK 的 analysis 查询及设备调用记录共同确认。

修改公共 hook 后运行这个案例及相邻类型/判定测试。有第二个目标的新 API 缺口时才继续扩展公共实现。
案例已接入现有 API33 CI；四个基础机制回归不能替代这里的公共 API 行为证明。
完整空文件映射可以表示未检出；缺失映射或错误内容不能算阴性。
CI 汇总分类与局限见 [测试策略](../../docs/TESTING_STRATEGY.md)。
