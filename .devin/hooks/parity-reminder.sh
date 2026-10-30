#!/bin/sh
# PostToolUse hook: after edit/write on an analysis-layer source file, remind
# the agent to run the parity gate (traces through npm + cargo + python).
# Stdin: {"tool_name","tool_input":{"file_path":...},"tool_response":{...}}
# Output schema: hookSpecificOutput.additionalContext injects the reminder.
python3 -c "
import json, re, sys
d = json.load(sys.stdin)
p = (d.get('tool_input') or {}).get('file_path', '')
pat = r'(cli-rs/src/(config|features|quality|blink|session|thresholds|eval|baseline|score)\.rs|cli/blinkwell/(config|features|quality|blink|session|thresholds|eval|baseline|scoreSession)\.py|src/lib/analysis/(config|features|quality|blink|session|thresholds|eval)\.ts)\$'
if re.search(pat, p):
    print(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PostToolUse',
        'additionalContext': 'Analysis-layer file changed — before claiming done, run the parity-check skill (synthetic + diag traces through npm/cargo/python, identical events and TP/FP/FN).'
    }}))
"
