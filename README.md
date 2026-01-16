# Strawberry Terminal Plugin Marketplace

A Claude Code plugin marketplace for VM orchestration, browser automation, and activity tracking.

## Quick Install

```bash
# Add this marketplace to Claude Code
/plugin marketplace add LiamFuller07/strawberry-terminal-plugin

# Install the strawberry-terminal plugin
/plugin install strawberry-terminal@strawberry-plugins
```

## What's Included

### strawberry-terminal Plugin

Provides:

- **VM Automation** - Spawn and control cloud VMs via TryCua
- **Local Computer Use** - Control your local Mac (screenshots, mouse, keyboard)
- **Activity Tracking** - Real-time Claude activity logging for the Strawberry terminal UI

#### Skills
- `vm-automation` - Cloud VM management
- `local-computer-use` - Local desktop control

#### Commands
- `/spawn-vm` - Spawn a new cloud VM
- `/local-screenshot` - Take a local screenshot

#### MCP Servers
- `trycua` - TryCua VM management API
- `local-computer-use` - Local Mac computer use

## Setup

### Environment Variables

Set the following before using:

```bash
# Required for TryCua VM features
export CUA_API_KEY="your-api-key-here"
```

### macOS Permissions

For local computer use, grant Accessibility permissions:
**System Settings > Privacy & Security > Accessibility**

## Development

```bash
# Clone
git clone https://github.com/LiamFuller07/strawberry-terminal-plugin.git
cd strawberry-terminal-plugin

# Add as local marketplace
/plugin marketplace add ./

# Install plugin locally
/plugin install strawberry-terminal@strawberry-plugins
```

## License

MIT
