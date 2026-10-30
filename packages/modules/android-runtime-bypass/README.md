# Android API hooks

此目录拥有可复用的 Android API 观察与干预实现。干预边界以
[Detection Intervention Contract](../../../AGENTS.md#detection-intervention-contract)
为准；本文只说明模块接口、配置和已经验证的能力范围。

## 入口

- `api-hooks.ts`：唯一的 API hook 实现，安装、观察、规则切换及恢复均在这里。
- `api-runtime.ts`：每个 Script 的唯一运行实例，供公共 RPC、组合能力和旧模块/观察订阅共用。
- `root-policy.json`：旧 root 模块与组合 CLI 共用的单一默认规则来源。
- `api-policy.ts`：简单值配置与命令文本转换；没有脚本表达式或规则引擎。
- `root-bypass.ts`：现有模块入口，提供默认 root 隐藏配置；通过
  `cfg.flags["android.api"]` 可以选择观察模式或自己的规则。
- `api-agent.ts`：独立的 Frida RPC 入口，与模块入口使用同一个实现。

在仓库根目录构建独立脚本：

```powershell
npm run build:api
```

产物为 `dist/android-api.js`。注入任意 Android Java 应用进程后使用标准 Frida RPC：

- `configure(policy)`：首次安装，之后完整替换当前配置；等待 Application ClassLoader 就绪。
- `drain()`：取得并清空这段时间的 API 观测，包含 `records` 和 `dropped`。
- `dispose()`：恢复字段、Java 方法和 native interceptor，然后再卸载脚本。

日常组合使用 `npm run cli -- list|plan|run`，见
[运行说明](../../../README.md#compose-existing-capabilities)。新入口在首次激活前确定安装 API 组，
仅跟踪选择的 trace 范围；匹配规则、实际修改和错误仍保留并分别计数。
`status` 回执包含计划组、实际安装及统计；`dropped` 表示证据丢失，不能当作完整观测。
API 原调用的正常异常保留为观测，`runtimeError` 才表示观察器或运行实现失败。
旧独立 RPC 保留原有全 API 安装范围与 configure/drain/dispose 合同。

独立 bundle 还提供 `AgentForgeAndroidApi` 的 Java bridge 工具导出，便于实验适配器
在同一个 Script 内共享桥。当前 API 33 x86_64 上曾观察到两份独立 bridge 卸载后
应用延迟崩溃，因此案例把只读适配器附到公共 bundle 后；卸载后再用系统输入复查。

通过现有 CLI 观察目标，在仓库根目录执行：

```powershell
npm run build:prod
npm run observe:android -- -s <package> --duration-ms 45000 --dump-events ../.runtime/frida/api-observe.jsonl
```

期间在应用中正常触发相关功能。CLI 通过 loader 的 shutdown 恢复有 deactivate 的模块，
再卸载脚本。默认 root 配置入口是 `configs/targets/root-default.json`。

## 两种模式

`{"mode":"observe","captureStack":true}` 记录实际调用、参数、返回和来源，不应用替换规则。
Runtime.exec 和 ProcessBuilder.start 返回真实 Process，不读取其输出流、等待退出或包装它。

`replace` 根据显式配置改变行为，例如：

```json
{
  "mode": "replace",
  "captureStack": true,
  "rules": {
    "fileExists": { "/system/xbin/su": true },
    "nativeFileRedirects": { "/system/xbin/su": "/proc/self/status" },
    "properties": { "ro.debuggable": "1" }
  }
}
```

将 fileExists 改为 false、native 路径改到不存在的路径、属性改为 0，
就可以验证同一检测项是否从阳性切换到阴性。目标名、库名和检测结论不进入规则解释器。

| 配置 | 对应行为 |
| --- | --- |
| fileExists | 精确绝对路径 → Java File.exists 布尔值 |
| nativeFileRedirects | 精确路径 → libc fopen/access/stat/open 的实际访问路径 |
| properties | 属性名 → SystemProperties.get、getprop、libc property getter/callback 中的字符串值 |
| packagesAbsent | 对应包名的 getPackageInfo 返回正常 NameNotFoundException |
| buildTags | 临时设置 Build.TAGS，恢复时使用原值 |
| buildFields | 显式 Build 字符串字段 → 构造值；移除、观察模式和 dispose 恢复原值并回读 |
| commandRedirects | 精确 argv → 新 argv，运行真实子进程 |
| readOnlyMounts | 精确挂载点的 mount 输出 rw → ro |

仅在 replace 且配置了相关规则时，getprop/mount 才使用输出包装；
保留真实子进程退出值、stderr、stdin 和生命周期，保留其它输出内容。
字段修改回执与 API 调用记录分开，Build.TAGS 设置不能冒充字段读取命中。

Runtime.exec 与 ProcessBuilder.start 共用命令处理，嵌套的 ProcessBuilder 不再次包装，
保留原有 Runtime.exec 观测。Native 属性通过真实 `__system_property_find` 句柄及
`__system_property_read_callback` 原回调链交付；不写 property area，不制造不存在的句柄。
原属性名、cookie、serial 和 callback 调用次数保持不变，每次调用使用入口时的策略。
`__system_property_get` 也执行原函数，并记录原/交付字符串、返回字节长度及 native
调用方。改写同时更新缓冲终止符与返回长度；缺失属性不创建，现有空属性仍可观测。
该旧 API 的构造值必须能放入 92 字节缓冲；超长 UTF-8、NUL 或无效编码会保留原值并
记录运行失败，不截断。这一上限不施加到原有 callback 路径。嵌套记录是各层观测，
不是额外独立覆盖；`original` 不替代无脚本基线。
每个 Script 保留一个 native dispatcher，原 callback 的函数包装按地址复用；每次读取
只分配独立 cookie/值上下文，避免为每次读取创建和回收可执行 callback。
dispose 先停止新干预，等待在途 callback 返回后解除 interceptor 并释放引用；超时失败，
调用方须停止自己拥有的测试进程再卸载，不能将失败回执当作已恢复。

组合 CLI 的 `build-fields` 能力仅支持 replace，没有默认画像或字段读取 trace。
它覆盖 BRAND、MANUFACTURER、MODEL、DEVICE、PRODUCT、BOARD、HARDWARE、FINGERPRINT、
TYPE、TAGS；不修改 SDK_INT、VERSION 或 ABI。只有显式选择此能力才允许 `rules.buildFields`，
root 仍只获得原有 TAGS 权限。旧 `buildTags` 与 `buildFields.TAGS` 共享同一字段 Owner；
同一输入给出不同值会失败，跨预设冲突仍由显式 profile 解决。
字段修改保存在独立的 `buildFields` 回执中，不增加 API 调用命中计数。配置不自动补齐
对应属性，不承诺多字段原子切换。见 [Duck 构建画像案例](../../../cases/duck-build-profile/README.md)。

## 观测与边界

Java 调用可携带调用栈；native 调用记录调用模块和地址。记录保留原参数、
返回结果、是否匹配规则和实际变化；native 路径被替换时记录真实调用结果，
不会为了取得“原始结果”再执行一次文件操作。
嵌套 Java/native 调用中的 original 是该层原调用返回值，可能已受更底层干预影响。
设备真实原值来自无干预基线，不能把嵌套记录当成多个独立来源。

观察队列最多保留 4096 项，超过后报告 dropped，不影响目标返回值。
CLI 的 trace-event 流仍可持续导出；案例在每个动作前后 drain，发现丢失即不宣称覆盖完成。

本次设备验收覆盖 RootBeer 与 detect-env 自己触发的 Java File.exists 和 libc fopen，
以及 RootBeer 的命令输出干预。其余已观察接口的范围与调用证据应按具体样本判断。
Duck 的四属性实验覆盖其反射、ProcessBuilder getprop 和 native callback 路径，见
[Duck 系统属性案例](../../../cases/duck-system-properties/README.md)。
直接 syscall、其它 overload、其它 libc 导出或自定义检测算法需要后续案例验证和扩展，
不能凭当前模块名称声称已经绕过。

同一进程内不要同时注入两个修改相同 API 的 hook 实现；这里不建立 hook 仲裁框架。
真实 APK 的运行与验收见 [RootBeer 案例](../../../cases/rootbeer/README.md)。
