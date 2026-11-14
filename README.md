# deepseek-status

在 Claude Code 输入框上方实时显示 DeepSeek 的模型、账户余额与推理等级，并支持快捷键切换模型和推理等级。

> 仅适用于通过 DeepSeek 的 Anthropic 兼容接口运行的 Claude Code。

```text
模型 deepseek-flash[1m] (按shift+\切换) · 余额 ¥21.77 · 谷时 · 距峰时 02:10:45 · 推理 max (shift+e)
```

`max` 等级的文字颜色会像 Claude Code 推理界面里的火焰一样循环变化。

## 声明

本项目的全部代码、测试与文档均由 AI（Claude Code）编写。

## 功能

- **当前模型**：读取会话主循环模型；用 `/model` 或本插件切换后自动同步。
- **DeepSeek 余额**：调用 `GET https://api.deepseek.com/user/balance`，在会话启动、每 60 秒以及每个主回合结束后刷新；只显示非零币种。
- **峰谷价格倒计时**：余额旁显示当前是峰时还是谷时，以及距下一次价格切换的倒计时，精确到秒。时段按北京时间（UTC+8）划分：00:30–08:30 为谷时，其余为峰时；定义在 `hooks/pricing.ts`，DeepSeek 调整时段时改那两个常量即可。
- **推理等级**：显示实际生效等级（包含静默降级）；`max` 时文字颜色循环动画。
- **模型切换**：空输入框按 `shift+\` 打开聚焦选择框，↑/↓ 选择，Enter 确认，Esc 取消；确认后关闭选择框并更新模型设置。
- **推理等级切换**：空输入框按 `shift+e` 打开 Claude Code 自带的 `/effort` 界面。
- **仅 DeepSeek**：base URL 不属于 `deepseek.com` 时完全不显示，不影响其他模型。

## 安装

需要 Claude Code 2.1.325 或更新版本（function hooks 早期访问）。

在 Claude Code 中运行：

```text
/plugin install deepseek-status --marketplace TGYC/claude-code-deepseek-status
```

或在 shell 中：

```bash
claude plugin install deepseek-status --marketplace TGYC/claude-code-deepseek-status
```

安装后插件会自动启用，横幅出现在输入框上方。

## 配置

Claude Code 需要指向 DeepSeek 的 Anthropic 兼容端点，例如在 `~/.claude/settings.json` 中：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "你的 DeepSeek API Key",
    "ANTHROPIC_MODEL": "deepseek-flash[1m]"
  }
}
```

mod 依次读取 `DEEPSEEK_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`，以及 settings 的 `env` 块。密钥只用于请求头，不会写入状态、界面或日志。

- 模型列表：`GET https://api.deepseek.com/models`
- 账户余额：`GET https://api.deepseek.com/user/balance`

> 如果希望 `/effort` 能自由切换等级，不要在 `env` 里设置 `CLAUDE_CODE_EFFORT_LEVEL` 作为硬覆盖；可以用 `modelSettings.<model>.effortLevel` 设置默认值。

## 快捷键

| 快捷键 | 条件 | 作用 |
| --- | --- | --- |
| `shift+\` | 输入框为空 | 打开/关闭模型选择框：↑/↓ 选择，Enter 确认，Esc 取消 |
| `shift+e` | 输入框为空 | 打开 Claude Code 自带的 `/effort` 推理等级界面 |

两个快捷键只在输入框为空时响应。以 `|` 或大写 `E` 开头的提示词会被当作快捷键；先输入一个空格或其他字符即可正常输入。

## 工作原理

- 余额与模型列表通过 `$.http.fetch` 读取，在会话启动、每 60 秒和每个主回合结束后刷新。
- 推理等级通过一次只读的 Bash 调用读取会话环境里的 `CLAUDE_EFFORT`（hooks worker 自身环境没有该变量），并在每次 `/effort` 调整后立即同步；回合结束时用 `Stop` hook 兜底。
- 模型切换通过内置 `/model <id>` 执行；确认后关闭选择框并更新设置。
- 推理等级界面通过内置 `/effort` 打开。

## 开发

```bash
claude plugin validate .
claude plugin test .
```
