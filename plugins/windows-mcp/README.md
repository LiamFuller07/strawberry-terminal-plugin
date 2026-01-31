# Windows-MCP plugin for Strawberry Terminal

This plugin exposes the [CursorTouch Windows-MCP](https://github.com/CursorTouch/Windows-MCP) MCP server inside the Strawberry terminal marketplace. Use it when you want to control **existing Windows RDP machines** instead of spawning new TryCua VMs.

## How it works

1. Place your Windows-MCP repo in `plugins/windows-mcp/windows-mcp` (already included).
2. On the Windows host (the RDP target) install `uv` and run `uv run windows-mcp`. Make sure the MCP server is reachable over TCP/HTTP.
3. Point Strawberry to the running endpoint by setting `WINDOWS_MCP_ENDPOINT` (e.g. `http://192.168.1.7:8080`).
4. The plugin can fall back to launching the bundled Windows-MCP locally (macOS/Linux) by running `uv --directory <path> run windows-mcp`, but for real Windows automation you should tunnel your RDP host to that endpoint.

## Auto-launch helper

- The helper `bin/start-windows-mcp.js` parses your `.rdp` file (`/Users/liam/Downloads/savelli-marketing-job.rdp`), starts `xfreerdp`, and runs `uvx windows-mcp` on the Windows desktop so you never have to manually log in and start the server.
- On macOS install FreeRDP (`brew install freerdp`) so `xfreerdp` is available.
- Environment overrides:
  - `WINDOWS_MCP_AUTO_LAUNCH` – set to `false` to skip the helper (defaults to `true`).
  - `WINDOWS_MCP_REMOTE_DIR` – directory on Windows containing the Windows-MCP repo (`C:\\WindowsMCP` by default).
  - `WINDOWS_MCP_REMOTE_CMD` – command executed on Windows to start the MCP server.
  - `WINDOWS_MCP_PASSWORD` – password when the `.rdp` file omits credentials.
  - `WINDOWS_MCP_PORT` – port to target when RDP is running on a non-standard port.

## RDP test file

Use `/Users/liam/Downloads/savelli-marketing-job.rdp` as the test target. Open it in Microsoft Remote Desktop, configure port forwarding so the Strawberry host can reach the MCP HTTP endpoint, and set `WINDOWS_MCP_ENDPOINT` accordingly.

## Tips

- Keep the Windows-MCP terminal running while you automate (State → Click/Type → Scroll).
- Call `State-Tool` with `use_vision=true` to populate screenshots for the sidebar.
- Map the `Click-Tool` coordinates from the State output before driving mouse actions.
