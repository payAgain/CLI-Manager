# Local Path Opening Contracts

## Scenario: WebView 打开本地路径

### 1. Scope / Trigger

- 前端需要打开用户项目、Worktree、终端识别出的本地目录或文件时适用。
- 不要为任意项目路径配置 WebView `opener` 全盘 scope；本地路径统一通过 Rust command。

### 2. Signatures

```rust
open_folder_in_explorer(
    app: AppHandle,
    path: String,
    open_file: Option<bool>,
) -> Result<(), String>
```

前端参数使用 camelCase：

```ts
invoke("open_folder_in_explorer", { path, openFile: true })
```

### 3. Contracts

- `path`：必须指向当前系统中已存在的文件或目录。
- `openFile = true` 且目标是文件：使用系统默认应用打开。
- 其他情况：目录直接打开；文件在系统文件管理器中定位。
- HTTP/HTTPS URL 继续使用前端 `openUrl`，不经过此 command。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| 路径不存在 | 返回 `路径不存在: <path>` |
| 默认应用启动失败 | 返回 `无法打开文件: <error>` |
| 文件管理器启动失败 | 返回 `无法打开文件夹: <error>` |

### 5. Good/Base/Bad Cases

- Good：终端外部文件传 `openFile: true`，由默认应用打开。
- Base：项目或 Worktree 目录仅传 `path`，由文件管理器打开。
- Bad：前端直接调用 `openPath(path)`，只配置 `opener:allow-open-path` 而未配置 scope，会产生 ACL/scope 拒绝。

### 6. Tests Required

- Rust 编译检查必须覆盖 command 参数及 `OpenerExt` 调用。
- TypeScript 类型检查必须覆盖所有 `invoke` 参数。
- 应用内手动验证目录、外部文件和 URL 三条路径。

### 7. Wrong vs Correct

#### Wrong

```ts
await openPath(project.path);
```

#### Correct

```ts
await invoke("open_folder_in_explorer", { path: project.path });
```
