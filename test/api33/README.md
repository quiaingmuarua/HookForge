# API 33 detect-env Frida 验证

Frida CI 在 rootable AOSP API 33 模拟器中运行四个用例，使用固定测试 Release 中的 `com.detect.app.sample`。
HookForge CI 使用 x86_64；AgentForge 保留的 Mac 集成使用其当前构建的 arm64-v8a APK。
行为断言和清理均成功才返回 `0`，失败返回非零并保存证据。

`prepare.py`、`suite.py`、`run.py`、`report.py` 和 RootBeer runner 接受
`--abi x86_64|arm64-v8a`；省略时保持原来的 x86_64 默认。schema-2
`toolchain.lock.json` 分别锁定两种 server 的二进制/压缩包 SHA256，并映射
Android ABI、Frida server asset 架构和实际进程架构。ARM64 不能复用 x86_64
server 或 APK；工具在注入前检查选择的 ABI，证据记录实际设备与进程架构。

这四项属于**运行机制回归**。这里直接替换测试 App Java/JNI 方法，只用于验证
拦截、RPC 和恢复，不能计入公共 API 对原检测的影响证明。
统一验收含义见 [测试策略](../../docs/TESTING_STRATEGY.md#two-proof-scopes)，
干预边界见 [Detection Intervention Contract](../../CLAUDE.md#detection-intervention-contract)。

| Host | 模式 | 验证内容 |
| --- | --- | --- |
| Python 探针 | attach、spawn | libc Native、JNI、Java Hook 的前后对照、RPC、异常传播、恢复和清理 |
| 正式 Node CLI | attach、spawn | 主机任务产出的同一份生产 bundle/CLI、loader-ready、指定模块激活、清理；spawn 开启 verbose |

CI 在这四项通过后，使用同一模拟器运行 RootBeer＋detect-env 真实界面对照。
公共 API bundle 来自 Host job 的生产 artifact；案例不会重新构建公共 hook。
RootBeer 样本来自固定测试 Release，下载步骤仅使用只读 token，并按案例声明校验 SHA256。
这部分单独标为**公共 API 行为验证**，API 命中、配置值变化、原检测结果和卸载后恢复分别保留证据。

| 探针 | 调用链 | 必须观测到的结果 |
| --- | --- | --- |
| Native Hook | RPC → `NativeFunction` → `libc.so!access` → `Interceptor` | `0 → -1 → 0`，一次 Hook 回调 |
| RPC | Python → Frida JS exports | JSON/中文/null 原样往返；异步求和 `42`；JS 和 Java 回调异常传回主机 |
| JNI Native Hook | RPC → Java → `FileHelper.check_file_exist_c` → `libdetect_sample.so` | `1 → 0 → 1`，一次 native 回调 |
| Java Hook | RPC → `FileHelper.fileExistResult(String)` | `true → false → true`，一次 Java 回调 |

探针只修改测试线程自身对 `/proc/self/status` 的调用结果，不修改文件。完成后撤销 Hook、卸载脚本、detach 并移除本轮 ADB 转发；本地保留模拟器、server 和应用，方便继续实验。

每个用例只由当前 host 建立 Frida 连接。Python 用例在 detach 后显式移除 remote device；Node 用例由正式 CLI 独占连接，准备阶段通过 ADB 校验 server 版本和哈希。

Java agent 显式导入仓库的 Java Bridge。Frida 17 的 `create_script()` 不保证存在全局 `Java`。Java agent 与生产 loader 共用 `initializeJavaClassLoader`，先通过 `Java.performNow` 和框架类获取应用 ClassLoader，再执行 `Java.perform`。调用 `FileHelper` 的现有静态方法会完成原生库初始化；共享 facade 将回调同步异常转为 Promise rejection。

## 环境准备

使用 `.node-version` 指定的 Node、Python 3.10+ 和 Android SDK；Actions 固定使用 Python 3.11。`ANDROID_HOME`、`JAVA_HOME` 和 PATH 应指向工具。本工作区的工具位于 `.runtime/toolchain`。

在仓库根目录执行：

先按下方命令下载并校验固定 APK。Windows 已安装 SDK、且 API 33 x86_64 模拟器已连接时，可直接用 PowerShell
复用同一套 Python 工具。`prepare.py` 在项目 `.runtime` 中创建匹配的 Python
client 和 server，不依赖系统 `frida` 命令的版本：

```powershell
python test/api33/prepare.py
npm run build:prod
npm run artifact:write
$fridaTools = Get-Content -LiteralPath .runtime/frida-api33/toolchain.json -Raw | ConvertFrom-Json
$fridaResults = ".runtime/frida-api33/results/local-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
& $fridaTools.python test/api33/suite.py `
  --apk .runtime/fixtures/detect-env-api33-x86_64.apk `
  --serial emulator-5554 --output $fridaResults
python -X utf8 test/api33/report.py --output $fridaResults
```

上面的 suite 用于验证公共运行环境；单个目标脚本通常只需要运行该目标。
首次连接 RootBeer 等样本可用 `configs/targets/baseline.json` 关闭业务 Hook，
避免默认 profile 改变正在观察的检测行为。

独立仓库下载固定测试 APK；不需要 JDK、Gradle 或 AgentForge 源码：

```bash
mkdir -p .runtime/fixtures
gh release download fixtures-detect-env-ee69bb3 --repo quiaingmuarua/HookForge   --pattern detect-env-api33-x86_64.apk --output .runtime/fixtures/detect-env-api33-x86_64.apk
node scripts/fixture.mjs .runtime/fixtures/detect-env-api33-x86_64.apk
npm ci
npm run build:hosts
npm run test:ci
npm run build:prod
npm run artifact:write
python test/api33/prepare.py
```

Linux 设备准备可安装 `platform-tools`、`emulator` 和
`system-images;android-33;default;x86_64`，再运行 `scripts/start-api33-emulator.sh`。
Windows 使用 Git Bash 和原生 Windows SDK，启动已有 API33 x86_64 AVD；不使用 WSL。
测试资产的来源、更新和独立 CI 见 [CI 说明](../../docs/CI.md)。

`prepare.py` 从 npm 锁文件读取 Frida 精确版本，创建 Python venv、安装匹配的 client，下载并校验匹配的 server。server 和压缩包的 SHA256 来自 `toolchain.lock.json`；升级 npm Frida 时必须同步更新这个校验锁。缓存目录中的损坏文件会失败，不会被当作可用 server。

`npm ci` 的 postinstall 将 `frida-java-bridge@7.0.13` 应用到仓库声明的补丁字节：
`patches/frida-java-bridge-7.0.13.patch.json` 同时固定官方 npm tarball 的完整性、
原始源码和修改后源码的 SHA256。补丁在 ART hook 保护安装后执行
`Interceptor.flush()`，再同步已有 replacement method 的入口；它不引入固定等待
或行为重试。`npm run check:bridge-patch` 可单独检查安装状态。

准备报告和每个运行用例都记录实际校验过的 `javaBridgePatch`；生产 manifest 使用
schema 2，write/verify 均核验已安装源码，记录补丁 ID、metadata SHA256 与
原始/修改后源码 SHA256。suite/report 拒绝缺少这些身份的旧证据，不能仅凭相同 npm
版本接受未打补丁的安装。报告期望值只读取已提交的 lock/metadata，因此 npm 安装失败、
`node_modules` 不存在时仍能写出初始化失败报告。更换补丁后必须重新安装、生产构建并生成
本轮 manifest 和运行证据；源码校验本身不代表设备行为通过。

AgentForge Mac 集成（不属于 HookForge CI）使用专属 runner root 内的 Android SDK、uv 管理的 Python 3.11 和每轮新
venv。准备时传 `--abi arm64-v8a --python <新venv/bin/python>`，让
`--tools-root` 仅保留已校验 server 缓存；`--output` 的 toolchain 报告属于本轮。
调用 suite 时同时传本轮 `--toolchain` 和 `--production-manifest`。
模拟器由 `emulator.py start|stop` 管理独立 AVD，替代 Linux 的 KVM/Action 准备。
路径约束、LaunchAgent、完整运行顺序与清理见
[Mac runner 运维说明](../../docs/MACOS_RUNNER.md)。

可指定 `--python /absolute/path/to/venv/bin/python`、`--node /absolute/path/to/node`、`--server /absolute/path/to/server`、`--tools-root /absolute/path/cache` 和 `--output /absolute/path/toolchain.json`。`--check-only` 校验现有环境并输出报告，不安装或下载工具。解释器路径保留 venv 入口，不将符号链接解析为系统 Python。

启动包装脚本调用 `emulator.py start`，等待模拟器 ready 后返回，不再前台挂住。
默认仍使用 x86_64、端口 5554；每次生成独立输出目录，并打印该次
`emulator.py stop --output <目录>` 命令。测试后执行打印的 stop 命令，保留归属记录和
`cleanup.json`。日志与 `state.json` 位于该次输出目录。
启动要求所选主机/镜像具备可用硬件加速，不再在缺少 KVM 时自动退回 `-accel off`。
Mac CI 显式选择 ARM64 和端口 5580，其独立 SDK/AVD 配置见运维说明。

## 复跑

已准备好的本工作区可单独运行 Python 探针：

```bash
bash scripts/run-api33-test.sh --mode attach
bash scripts/run-api33-test.sh --mode spawn
```

完整执行四个用例时，先运行生产构建和 `artifact:write`，并提供新的输出目录：

```bash
python3 test/api33/suite.py \
  --apk .runtime/fixtures/detect-env-api33-x86_64.apk \
  --output .runtime/frida-api33/results/my-new-run
python3 test/api33/report.py \
  --output .runtime/frida-api33/results/my-new-run
```

指定 `android.injected.build.abi` 时 AGP 将 APK 写入 `intermediates/apk/debug` 并标记 `testOnly`；包装脚本也支持标准的 `outputs/apk/debug`。安装使用 `adb install -r -t`。suite 可用 `--toolchain` 指向准备报告，`--adb`、`--serial`、`--production-manifest` 指定外部工具和产物。

单独运行正式 Node 用例：

```bash
python3 test/api33/run.py --serial emulator-5554 \
  --apk /absolute/path/detect-env-debug.apk \
  --server /absolute/path/frida-server --host node --mode spawn
```

该命令需要已安装 Python Frida，可用准备报告中的 `python` 解释器执行。Node 用例运行 `dist/node-cli/run.js` 和 `dist/bundle.js`，逐个校验生产产物哈希、checkout SHA、Node 版本和依赖锁哈希。开发 hosts 位于 `hosts/node-cli`，生产构建将 CLI 写入 `dist/node-cli`，不会覆盖开发 hosts。

## 失败条件和证据

`run.py` 拒绝真实设备、非 API 33、与所选 ABI 不符、未完成启动的设备，以及 client/server/锁文件不匹配的环境。版本和 ABI 在注入前校验。只有 server 初始化连接进行有界重试；Hook/RPC 断言不会重试。

Node smoke 必须收到 `loader-ready`，并满足重复传入的 `--require-module ID` / `--require-recipe ID`。超时、模块失败、结构化运行时错误、loader/script error、意外 detach 和卸载/detach 失败均返回非零；verbose 仍处理全部消息。`--result FILE` 保存结果。

受控负向实验可向 Python 用例传入 `--native-agent /absolute/path/probe.js`，例如仅将探针替换返回值从 `-1` 改为 `-2`，确认断言失败且清理仍完成。失败结果会保存实际的 before/hooked/restored 值。CI 默认使用仓库原始探针。

每个用例保存：

- `result.json`：失败阶段、环境、APK/server/脚本哈希、行为检查和清理结果。
- `messages.jsonl`、`commands.jsonl`、`logcat.txt`：消息、主机命令和设备日志。
- Python 用例保存探针、Java bundle 和共享 facade 快照；Node 用例保存 `node-result.json`，包含 loader/module 状态、消息和清理。
- `installed-detect-env.apk`：从设备取回并核对 SHA256 的实际 APK。

suite 不覆盖旧结果；一项失败仍保留其他独立用例的结果，最终任一失败都返回非零。
`summary.json` 保存四项机制回归，报告生成的 `summary.md` 同时显示两类证明。
`job-result.json` 保留原有 suite、rootbeer 和步骤失败，并包含镜像 revision、emulator/adb 版本。

完整 CI 的案例结果位于本次结果根目录的 `rootbeer/result.json`。
汇总命令追加 `--case-result <该文件>`，要求生产产物模式、detect-env 复用和案例 Host 判定均通过。
结果缺失、损坏或验证失败时，`job-result.json.rootbeer` 记录原因，报告返回非零。
新增的 `proofs.runtimeMechanisms` 记录机制状态和 `summary.json` 路径；
`proofs.sharedApiBehavior` 记录行为状态、案例路径及公共脚本哈希，均为已有结果的汇总投影。
Actions Summary 分开展示两类证明和案例对照。只验证基础运行环境时可省略该参数，
公共行为状态明确为 `not-requested`，不能把该次成功解释为检测干预验证通过。

Mac 完整 lane 在汇总前停止本轮模拟器，并传
`--cleanup-result <emulator/cleanup.json>`；缺失、损坏或失败的清理证据会使报告失败。
每轮结果目录必须全新；只有证据上传与模拟器清理都成功，workflow 才删除带有匹配
run ID/attempt 归属标记的临时目录。初始化、上传或资源清理失败时保留可用证据。

源码和文档保存在 Git；生成证据位于 `.runtime`。Actions 使用 `if: always()` 上传已有证据，名称包含 run ID/attempt，保留 7 天。上传包保留一个构建 APK，各用例安装副本用哈希对应。CI 覆盖基础 Frida 行为以及固定 RootBeer 和 detect-env 的公共 API 对照；其它第三方 App、真实 ARM 设备及 XA Mass Worker 业务仍使用各自验收流程。
