---
name: vm-automation
description: This skill should be used when the user asks to "spawn a VM", "create virtual machine", "launch VM", "start a browser agent", "run browser automation", "control a VM", "take VM screenshot", "click on VM", "type in VM", or discusses cloud VMs, TryCua, or remote computer control.
version: 1.0.0
allowed-tools: mcp__plugin_strawberry-terminal_trycua__*
---

# VM Automation Skill

This skill provides cloud VM management and computer-use capabilities via TryCua.

## When to Use
- Spawning new cloud VMs (Windows, macOS, Linux)
- Controlling VMs with mouse/keyboard actions
- Taking screenshots of VM screens
- Running browser automation tasks
- Managing multiple VMs with tags

## Available Tools

### VM Lifecycle
- `spawn_vm` - Create a new cloud VM
- `list_vms` - List all VMs and their status
- `stop_vm` - Terminate a running VM
- `get_pool_status` - Check VM capacity

### Computer Use
- `computer_action` - Click, type, scroll, key press on a VM
- `get_screenshot` - Capture current VM screen
- `execute_task` - Run a high-level task on a VM

### Multi-VM Operations
- `find_vms_by_tag` - Find VMs by tag
- `execute_on_tagged_vms` - Run task on all VMs with a tag
- `add_vm_tags` / `remove_vm_tags` - Manage VM tags
- `list_all_tags` - See all tags in use

## VM Types
- Windows (default)
- macOS
- Linux

## Regions
- north-america (default)
- europe
- asia-pacific
- south-america

## Example Usage

```
User: Spawn a Windows VM for browser testing
Assistant: I'll create a Windows VM tagged for browser automation.
[Uses spawn_vm with name="Browser Agent", os_type="windows", tags=["browser-test"]]

User: Take a screenshot of the VM
Assistant: [Uses get_screenshot with vm_id]

User: Click on the Chrome icon at coordinates 100, 200
Assistant: [Uses computer_action with action="click", x=100, y=200]
```
