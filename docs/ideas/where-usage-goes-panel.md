# Where usage goes panel: move and collapse

Two changes to the **Where usage goes** panel: the Main thread vs subagents bar, the
Context size bar, and the Skills and Subagents cost-share lists.

1. Move the panel so it sits directly below the **Plan usage** panel.
2. Keep the Skills and Subagents lists in this panel, but give each its own collapse
   toggle and start both collapsed. The two stacked bars stay visible.

## Open questions

- Rows of panels already collapse to their headings, and each browser remembers that
  state. Should the Skills and Subagents toggles be remembered the same way, or reset
  to collapsed on every load? "Start collapsed" fits either one.
- Plan usage only shows on the Today range. On 7D, 30D, 90D and All the panel needs a
  defined position, most likely the same slot with Plan usage absent.
