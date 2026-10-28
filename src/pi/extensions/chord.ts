// chord's pi extension. The wrapper loads it with `-e` (see launch.ts); it runs inside pi's own process, so it imports
// nothing of chord's: each event spawns `node $CHORD_HOOKS <event>` with the same payload shape the Claude Code and
// Codex hook commands send, and hands the answer back the way pi allows. chord's tools come from the MCP server
// $CHORD_SERVE, registered here so that the user's own ~/.pi stays untouched.
import { spawnSync } from 'node:child_process';

type HookOut = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string }; decision?: string; reason?: string } | undefined;

/** Enough of pi's ExtensionAPI and ExtensionContext for what the extension asks of them. */
type Pi = { on(event: string, handler: (event: any, ctx: Ctx) => any): unknown; registerMcpServer(name: string, config: object): void };
type Ctx = { sessionManager: { getSessionId(): string } };

const hook = (event: string, payload: object): HookOut => {
  const r = spawnSync('node', [process.env.CHORD_HOOKS!, event], { input: JSON.stringify(payload), encoding: 'utf8', env: process.env, windowsHide: true });
  try { return r.stdout ? JSON.parse(r.stdout) : undefined; } catch { return undefined; }
};
const context = (out: HookOut) => out?.hookSpecificOutput?.additionalContext;

export default function chord(pi: Pi): void {
  if (!process.env.CHORD_AGENT_ID || !process.env.CHORD_HOOKS || !process.env.CHORD_SERVE) return; // a plain pi run: chord is not here
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('CHORD_') && v !== undefined)) as Record<string, string>;
  // pi's default exposure, codemode, keeps MCP tools out of the model's sight; finish may wait minutes for the merge lock
  pi.registerMcpServer('chord', { command: process.execPath, args: [process.env.CHORD_SERVE], env, exposure: 'direct', timeout: 600, description: 'Coordination with the other agents on this project: register, claim files, send messages, finish' });
  let briefing: string | undefined; // the session's briefing, handed to the model with its first prompt
  pi.on('session_start', (e, ctx) => {
    briefing = context(hook('session-start', { session_id: ctx.sessionManager.getSessionId(), source: e.reason }));
  });
  pi.on('before_agent_start', (e, ctx) => {
    const texts = briefing ? [briefing] : [];
    briefing = undefined;
    const r = context(hook('user-prompt-submit', { session_id: ctx.sessionManager.getSessionId(), prompt: e.prompt ?? '' }));
    if (r) texts.push(r);
    // a custom message: the model reads it, the transcript shows it apart from what the user typed
    return texts.length ? { message: { customType: 'chord', content: texts.join('\n\n'), display: true } } : undefined;
  });
  pi.on('tool_call', (e, ctx) => {
    const d = hook('pre-tool-use', { session_id: ctx.sessionManager.getSessionId(), tool_name: e.toolName, tool_input: e.input })?.hookSpecificOutput;
    if (d?.permissionDecision === 'deny') return { block: true, reason: d.permissionDecisionReason ?? 'refused by chord' }; // the model reads the reason
  });
  pi.on('tool_result', (e, ctx) => {
    const r = context(hook('post-tool-use', { session_id: ctx.sessionManager.getSessionId(), tool_name: e.toolName, tool_input: e.input }));
    if (r) return { content: [...e.content, { type: 'text', text: r }], structuredContent: e.structuredContent };
  });
  pi.on('agent_before_settle', (e, ctx) => {
    // messages that arrived during the run: one more run to deal with them, as the Stop hook makes Claude Code take
    const out = hook('stop', { session_id: ctx.sessionManager.getSessionId() });
    if (out?.decision === 'block' && out.reason) return { entries: [...e.entries, { type: 'custom_message', customType: 'chord', content: out.reason, display: true }], continue: true };
  });
  // idle marks the agent idle without taking its messages; the wrapper's nudge delivers them through the prompt.
  // Fires after an Esc too, which skips agent_before_settle.
  pi.on('agent_settled', (_e, ctx) => { hook('notification', { session_id: ctx.sessionManager.getSessionId(), notification_type: 'idle_prompt' }); });
  pi.on('session_shutdown', (e, ctx) => { hook('session-end', { session_id: ctx.sessionManager.getSessionId(), reason: e.reason }); });
}
