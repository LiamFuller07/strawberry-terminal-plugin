---
description: Take a screenshot of the local Mac screen
argument-hint: [--display 1]
allowed-tools: [mcp__plugin_strawberry-terminal_local-computer-use__local_screenshot, mcp__plugin_strawberry-terminal_local-computer-use__local_get_display_info]
---

# /local-screenshot Command

Capture a screenshot of the local Mac desktop.

## Arguments
$ARGUMENTS

## Instructions

1. Parse arguments:
   - `--display` specifies which display (default: 1 = primary)

2. Call `local_screenshot` to capture the screen

3. Display the screenshot to the user

4. Optionally describe what's visible on the screen

## Requirements

Requires Accessibility permissions in macOS System Settings.

## Example Usage

```
/local-screenshot
/local-screenshot --display 2
```
