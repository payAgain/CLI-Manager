# Project File Command Contracts

> Concrete Tauri command contracts for browsing and editing files inside a configured project root.

---

## Scenario: Project-Scoped File Browser

### 1. Scope / Trigger

- Trigger: any Tauri command that reads, writes, creates, deletes, copies, moves, or searches files under a user-selected project path.
- Boundary: the frontend passes `rootPath` plus relative paths; Rust is the authority for path validation and filesystem effects.
- Non-goal: do not broaden `assetProtocol.scope` or use frontend-side fs access for project files.

### 2. Signatures

Backend commands in `src-tauri/src/commands/fs.rs`:

```rust
file_list_dir(root_path: String, relative_path: String) -> Result<Vec<FileEntry>, String>
file_search(root_path: String, query: String) -> Result<Vec<FileEntry>, String>
file_read_text(root_path: String, relative_path: String) -> Result<TextFilePayload, String>
file_read_image(root_path: String, relative_path: String) -> Result<ImageFilePayload, String>
file_write_text(root_path: String, relative_path: String, content: String) -> Result<(), String>
file_create_file(root_path: String, parent_path: String, name: String, overwrite: bool) -> Result<(), String>
file_create_dir(root_path: String, parent_path: String, name: String, overwrite: bool) -> Result<(), String>
file_rename(root_path: String, relative_path: String, new_name: String, overwrite: bool) -> Result<(), String>
file_delete(root_path: String, relative_path: String) -> Result<(), String>
file_copy(root_path: String, source_path: String, target_parent_path: String, name: String, overwrite: bool) -> Result<(), String>
file_move(root_path: String, source_path: String, target_parent_path: String, name: String, overwrite: bool) -> Result<(), String>
```

Payloads:

```rust
FileEntry { name: String, path: String, kind: String, size_bytes: u64, modified_ms: Option<u64> }
TextFilePayload { content: String, size_bytes: u64 }
ImageFilePayload { data_base64: String, mime_type: String, size_bytes: u64 }
```

### 3. Contracts

- `rootPath` must be absolute, canonicalizable, and a directory.
- Relative path fields use forward slashes only; empty string means project root where accepted.
- `name` / `newName` are single child names only; they must not contain `/` or `\`.
- `file_read_text` only returns UTF-8 text and rejects files larger than `TEXT_FILE_MAX_BYTES`.
- `file_read_image` returns base64 plus MIME type and rejects files larger than `IMAGE_FILE_MAX_BYTES`.
- `overwrite=false` must return `target_exists` when the destination exists.
- `overwrite=true` may replace the target after Rust revalidates the destination stays inside root.

### 4. Validation & Error Matrix

| Condition | Error |
|---|---|
| `rootPath` is relative | `root_not_absolute` |
| `rootPath` does not exist or cannot canonicalize | `root_canonicalize_failed: ...` |
| `rootPath` is not a directory | `root_not_directory` |
| Relative path contains `\` | `path_contains_backslash` |
| Relative path contains `.` segment | `path_contains_current_segment` |
| Relative path contains `..` segment | `path_contains_parent_segment` |
| Relative path is absolute | `path_is_absolute` |
| Canonicalized path escapes root | `path_outside_root` |
| Child name is empty, `.` or `..` | `empty_name` / `invalid_name` |
| Child name contains path separator | `name_contains_separator` |
| Delete target is root | `cannot_delete_root` |
| Copy/move directory into itself | `target_inside_source` |
| Destination exists without overwrite | `target_exists` |
| Text file is too large | `file_too_large` |
| Text file is not UTF-8 | `not_utf8` |
| Image extension unsupported | `unsupported_image` |

### 5. Good/Base/Bad Cases

- Good: `file_list_dir(rootPath, "")` returns sorted directories before files, with project-relative `path`.
- Base: `file_write_text(rootPath, "src/App.tsx", content)` writes only if `src` remains inside `rootPath`.
- Bad: `file_delete(rootPath, "")` must fail with `cannot_delete_root`.
- Bad: `file_copy(rootPath, "src", "src/nested", "src", true)` must fail with `target_inside_source`.

### 6. Tests Required

- Unit-test `validate_relative_path` accepts root and nested paths.
- Unit-test `validate_relative_path` rejects absolute, parent, current, and backslash paths.
- Unit-test `validate_child_name` rejects empty names, `.` / `..`, and separators.
- Unit-test canonicalization rejects paths outside root.
- Unit-test copy and move stay inside root and enforce `target_exists` / `target_inside_source`.

### 7. Wrong vs Correct

#### Wrong

```typescript
// Do not expose arbitrary project files through WebView asset scope.
const imageUrl = convertFileSrc(`${project.path}/${relativePath}`);
```

#### Correct

```typescript
const image = await invoke<ProjectImageFilePayload>("file_read_image", {
  rootPath: project.path,
  relativePath,
});
```

Rust validates `rootPath` and `relativePath`, reads the file, and returns bounded data without expanding global file access.
