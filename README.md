# TrustedInstaller 完全权限

面向 DSH 0.2.2-rc.4 的 Windows 权限模式。2.0 使用 DSH 宿主已经持有且已启用的 TrustedInstaller 令牌。普通用户、管理员和没有该 SID 的 SYSTEM 宿主都会收到工具拒绝。插件本身不启动提权代理、服务或 UAC。

```sh
dsh plugin --profile web add github:324641aliyun/dsh-full-permission-real
```

在权限选择器中选择「TrustedInstaller 完全权限」。每次直接调用前台 `pwsh` 或文件工具时，插件先检查令牌，再使用 DSH 自带的 Auto reviewer 审查会话授权、工具和参数。审批拒绝与原因作为工具错误返回给模型，允许改写后重新提交。审批异常时阻止执行。此版本限直接前台 PowerShell 和文件工具，阻止委派、后台作业和交互终端续写。

宿主的 Windows 身份属于整个进程。在本模式以外运行的代码同样继承宿主令牌。逐次审查覆盖本预设下通过 DSH 派发的工具调用；同一脚本中的语句作为一个整体审查。提示词明确说明真实系统文件、注册表和服务可能受到影响，要求先检查目标、缩小操作范围和验证结果。拒绝记录可在正常会话工具日志中看到，不会弹出人工审批。

旧版本的管理员代理模式已移除。升级应结束原宿主进程，再从新宿主加载新版。仓库的市场索引也提供独立的基础对话插件。

[市场索引](https://raw.githubusercontent.com/324641aliyun/dsh-full-permission-real/main/market/index.json)
