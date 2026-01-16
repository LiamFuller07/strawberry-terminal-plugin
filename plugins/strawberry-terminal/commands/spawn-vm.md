---
description: Spawn a new cloud VM for browser automation
argument-hint: <name> [--os windows|macos|linux] [--tags tag1,tag2]
allowed-tools: [mcp__plugin_strawberry-terminal_trycua__spawn_vm, mcp__plugin_strawberry-terminal_trycua__list_vms]
---

# /spawn-vm Command

Spawn a new cloud VM using TryCua for browser automation and computer-use tasks.

## Arguments
$ARGUMENTS

## Instructions

1. Parse the arguments:
   - First argument is the VM name (required)
   - `--os` flag specifies OS type: windows (default), macos, linux
   - `--tags` flag specifies comma-separated tags

2. Call `spawn_vm` with the parsed parameters

3. Report the VM ID and status when ready

4. The VM will be available for computer_action, get_screenshot, and execute_task operations

## Example Usage

```
/spawn-vm "Browser Agent"
/spawn-vm "Test VM" --os linux --tags browser,production
/spawn-vm "Mac Tester" --os macos
```
