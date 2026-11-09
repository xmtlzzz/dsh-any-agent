# 设计系统（本地参考）

这里存放两套设计系统，供编码 agent 写 UI 前加载。它们只是参考文件，**不影响官网**：官网的实际样式仍以 `website/src/style.css` 为准。这个目录也不在 npm 包的 `files` 白名单里，不会被发布。

| 文件 | 风格 | 来源 |
|---|---|---|
| [`dsh-any-agent/DESIGN.md`](dsh-any-agent/DESIGN.md) | 官网现有风格：深蓝底、单一蓝色强调色、粗体紧排标题、等宽小标签，暗色为默认、另有浅色主题 | 从 `website/src/style.css` 提取的实际取值 |
| [`claude/DESIGN.md`](claude/DESIGN.md) | Claude 风格：奶油底、衬线标题、珊瑚色主按钮、深色代码卡片（非官方，与 Anthropic 无关） | `npx getdesign@latest add claude` 的原样输出 |

## 怎么用

让 agent 在动手前先读对应文件，例如：

> 按 `design-systems/dsh-any-agent/DESIGN.md` 的风格写这个页面。

两份文件格式相同：开头的 YAML 是 token（颜色、字体、圆角、间距、组件），后面是用法说明和注意事项。

## 更新

- `claude/`：getdesign 默认写到当前目录的 `DESIGN.md`。仓库根目录的 `DESIGN.md` 是项目早期的架构草案，所以要在子目录里运行：

  ```bash
  cd design-systems/claude && npx getdesign@latest add claude
  ```

- `dsh-any-agent/`：官网改样式后，按 `website/src/style.css` 同步更新这份文件。
