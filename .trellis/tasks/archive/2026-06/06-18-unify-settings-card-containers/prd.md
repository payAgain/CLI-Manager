# 统一设置页卡片容器

## Goal

将设置页中作为分组外壳使用的 `ui-surface-card` 容器改成与“关于”区块一致的原生容器，避免 Mantine `Card` 默认背景覆盖项目自定义背景，造成设置页同级区块底色不一致。

## What I already know

* 用户指出“用量分析”和“关于”背景颜色不一致。
* “关于”使用 `section.ui-surface-card.rounded-2xl.border.border-border.p-4`。
* “用量分析”等设置分组使用 Mantine `<Card className="ui-surface-card" ...>`。
* `ui-surface-card` 在 `src/App.css` 中定义 `background-color: var(--surface-container-lowest)`。
* Mantine 样式由 `src/components/SettingsModal.tsx` 引入，Mantine `Card` 可能覆盖背景。

## Requirements

* 设置页中作为页面分组外壳的 `ui-surface-card` Mantine `Card` 改为原生 `section` 或 `div`。
* 容器 class 统一包含 `ui-surface-card rounded-2xl border border-border`。
* 保留现有布局语义：原有 `p`、`style`、响应式 class、flex/min-height 等布局约束要等价迁移。
* 不改内层普通选项卡、提示卡、表格行、警告卡等非外层容器。

## Acceptance Criteria

* [ ] 设置页同级外层容器背景与“关于”区块一致。
* [ ] TypeScript 检查通过。
* [ ] 不引入新依赖，不修改主题变量。

## Definition of Done

* 完成代码修改。
* 运行 `npx tsc --noEmit`。
* 检查 GitNexus 变更影响。

## Out of Scope

* 不重做设置页布局。
* 不修改 Mantine 主题或全局主题色。
* 不调整非设置页组件。

## Technical Notes

* 候选文件：`src/components/settings/pages/*.tsx`、`src/components/settings/AboutSection.tsx`。
* 主要匹配：`<Card className="ui-surface-card"...>`。
* 特殊保留：`p={0}` 容器保留为 `p-0`；有 `style` 的容器迁移原 style。
