# Implementation Plan

1. 增加 `workspanEnabled` 设置、加载校验、设置页开关和中英文文案。
2. 增加 Workspan → 旧版单容器的纯转换函数及测试。
3. 在 terminalStore 增加运行时模式切换，并接入普通终端创建与启动恢复。
4. 在 TerminalTabs 按模式切换顶层 Workspan 栏和 Pane Tab 栏。
5. 更新 CHANGELOG `[TEMP]` 与功能清单。
6. 运行专项测试和 TypeScript 类型检查，审查差异与影响范围。
