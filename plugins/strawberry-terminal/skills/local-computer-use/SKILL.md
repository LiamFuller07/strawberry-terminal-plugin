---
name: local-computer-use
description: This skill should be used when the user asks to "take a screenshot", "screenshot my screen", "click on my screen", "control my Mac", "automate my desktop", "type on my computer", "press keys", "move mouse", or discusses local desktop automation and screen capture.
version: 1.0.0
allowed-tools: mcp__plugin_strawberry-terminal_local-computer-use__*
---

# Local Computer Use Skill

This skill provides local Mac desktop control - screenshots, mouse, and keyboard automation.

## When to Use
- Taking screenshots of the local Mac screen
- Clicking at coordinates on the local screen
- Typing text locally
- Pressing keyboard shortcuts
- Moving the mouse cursor
- Scrolling
- Checking accessibility permissions

## Available Tools

- `local_screenshot` - Capture the local Mac screen
- `local_computer_action` - Perform mouse/keyboard actions:
  - `left_click` - Left click at coordinates
  - `right_click` - Right click at coordinates
  - `double_click` - Double click
  - `triple_click` - Triple click
  - `mouse_move` - Move cursor to position
  - `left_click_drag` - Click and drag
  - `type` - Type text
  - `key` - Press keyboard key with modifiers
  - `scroll` - Scroll up/down/left/right
  - `cursor_position` - Get current cursor position
- `local_get_display_info` - Get display resolution, scale factor
- `local_check_permissions` - Check accessibility permissions status

## Requirements

The local computer use feature requires **Accessibility permissions** in macOS:
System Settings > Privacy & Security > Accessibility

## Example Usage

```
User: Take a screenshot of my screen
Assistant: [Uses local_screenshot]

User: Click on the Dock at position 500, 900
Assistant: [Uses local_computer_action with action="left_click", x=500, y=900]

User: Type "Hello World" in the current app
Assistant: [Uses local_computer_action with action="type", text="Hello World"]

User: Press Cmd+C to copy
Assistant: [Uses local_computer_action with action="key", key="c", modifiers=["cmd"]]
```
