# Privacy

It runs entirely on your machine. It sends nothing over the network. It looks only at whether each tool call failed or succeeded and at the call's command, file path, URL, search query or MCP arguments, which it uses to tell operations apart and to label tiles. Those full keys are kept in this session's state only. It keeps the session's wall in Claude Code's session state and, at the end of a session, a small summary (counts and the label of the most-failed operation) in Claude Code's local plugin store.

The mod collects no analytics or telemetry, and its author receives no data from it.

Questions: https://github.com/ccdwyer/fault-lacquer/issues
