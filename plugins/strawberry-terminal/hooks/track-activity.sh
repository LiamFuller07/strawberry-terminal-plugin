#!/bin/bash
# Strawberry Terminal Activity Tracker
# Sends Claude Code activity to the Strawberry UI via file and HTTP

EVENT_TYPE="$1"
INPUT=$(cat)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Output locations
ACTIVITY_FILE="/tmp/strawberry-activity.jsonl"
STATUS_FILE="/tmp/bat-status.json"
EVENTS_FILE="/tmp/bat-mcp-events.jsonl"
HTTP_PORT="7890"

# Extract session info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // "~"' 2>/dev/null)

# Build payload based on event type
case "$EVENT_TYPE" in
  "pre")
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null)

    # Create human-readable action description
    case "$TOOL_NAME" in
      "Bash")
        CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null | head -c 60)
        ACTION="Running: $CMD"
        ;;
      "Read")
        FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null | xargs basename 2>/dev/null)
        ACTION="Reading: $FILE"
        ;;
      "Write"|"Edit")
        FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null | xargs basename 2>/dev/null)
        ACTION="Editing: $FILE"
        ;;
      "Glob"|"Grep")
        PATTERN=$(echo "$INPUT" | jq -r '.tool_input.pattern // ""' 2>/dev/null | head -c 30)
        ACTION="Searching: $PATTERN"
        ;;
      "Task")
        DESC=$(echo "$INPUT" | jq -r '.tool_input.description // ""' 2>/dev/null | head -c 40)
        ACTION="Agent: $DESC"
        ;;
      mcp__trycua__*)
        TOOL_SHORT="${TOOL_NAME#mcp__trycua__}"
        ACTION="VM: $TOOL_SHORT"
        ;;
      mcp__local-computer-use__*)
        TOOL_SHORT="${TOOL_NAME#mcp__local-computer-use__}"
        ACTION="Local: $TOOL_SHORT"
        ;;
      mcp__*)
        ACTION="MCP: $TOOL_NAME"
        ;;
      *)
        ACTION="$TOOL_NAME"
        ;;
    esac

    PAYLOAD=$(jq -n \
      --arg ts "$TIMESTAMP" \
      --arg event "tool_start" \
      --arg tool "$TOOL_NAME" \
      --arg action "$ACTION" \
      --arg session "$SESSION_ID" \
      --argjson input "$TOOL_INPUT" \
      '{timestamp: $ts, event: $event, tool: $tool, action: $action, session_id: $session, input: $input}')
    ;;

  "post")
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)
    # Truncate response to avoid huge files
    TOOL_RESPONSE=$(echo "$INPUT" | jq -c '.tool_response // null' 2>/dev/null | head -c 500)

    PAYLOAD=$(jq -n \
      --arg ts "$TIMESTAMP" \
      --arg event "tool_complete" \
      --arg tool "$TOOL_NAME" \
      --arg session "$SESSION_ID" \
      --arg response "$TOOL_RESPONSE" \
      '{timestamp: $ts, event: $event, tool: $tool, session_id: $session, response: $response}')
    ;;

  "stop")
    PAYLOAD=$(jq -n \
      --arg ts "$TIMESTAMP" \
      --arg event "claude_stopped" \
      --arg session "$SESSION_ID" \
      '{timestamp: $ts, event: $event, session_id: $session}')
    ;;

  "session-start")
    SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null)
    PAYLOAD=$(jq -n \
      --arg ts "$TIMESTAMP" \
      --arg event "session_start" \
      --arg source "$SOURCE" \
      --arg session "$SESSION_ID" \
      --arg cwd "$CWD" \
      '{timestamp: $ts, event: $event, source: $source, session_id: $session, cwd: $cwd}')
    ;;

  "prompt")
    PAYLOAD=$(jq -n \
      --arg ts "$TIMESTAMP" \
      --arg event "user_prompt" \
      --arg session "$SESSION_ID" \
      '{timestamp: $ts, event: $event, session_id: $session}')
    ;;

  *)
    PAYLOAD=$(jq -n \
      --arg ts "$TIMESTAMP" \
      --arg event "$EVENT_TYPE" \
      --arg session "$SESSION_ID" \
      '{timestamp: $ts, event: $event, session_id: $session}')
    ;;
esac

# Write to activity file (async, don't block)
echo "$PAYLOAD" >> "$ACTIVITY_FILE" 2>/dev/null &

# Also write to MCP events file for sidebar
echo "$PAYLOAD" >> "$EVENTS_FILE" 2>/dev/null &

# Try HTTP endpoint (non-blocking, ignore errors)
curl -s -X POST "http://localhost:$HTTP_PORT/activity" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 &

# Always exit 0 to not block Claude
exit 0
