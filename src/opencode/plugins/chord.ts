// chord's OpenCode plugin. OpenCode loads it from the directory OPENCODE_CONFIG_DIR names (see launch.ts) and runs it
// inside its own process, so it imports nothing of chord's: each hook spawns `node $CHORD_HOOKS <event>` with the same
// payload shape the Claude Code and Codex hook commands send, and hands the answer back the way OpenCode allows.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

type HookOut = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } } | undefined;

/** The tool of a session, enough of the SDK client for what the plugin asks it. */
type Client = { session: { get(input: { path: { id: string } }): Promise<{ data?: { parentID?: string } }> } };

const hook = (event: string, payload: object): HookOut => {
  const r = spawnSync('node', [process.env.CHORD_HOOKS!, event], { input: JSON.stringify(payload), encoding: 'utf8', env: process.env, windowsHide: true });
  try { return r.stdout ? JSON.parse(r.stdout) : undefined; } catch { return undefined; }
};
const context = (out: HookOut) => out?.hookSpecificOutput?.additionalContext;
// OpenCode orders a message's parts by id, so a part needs one of its own ascending ids: 12 hex digits of
// (ms << 12 | counter), then 14 random base62 characters
let counter = 0;
const partId = () => `prt_${((BigInt(Date.now()) * 4096n + BigInt(counter++ % 4096)) % (1n << 48n)).toString(16).padStart(12, '0')}${randomUUID().replace(/-/g, '').slice(0, 14)}`;

export const ChordPlugin = async ({ client }: { client: Client }) => {
  if (!process.env.CHORD_AGENT_ID || !process.env.CHORD_HOOKS) return {}; // a plain opencode run: chord is not here
  const briefed = new Set<string>();
  const children = new Map<string, boolean>();
  // a subagent (the task tool) runs in a child session; what it is told never reaches the main conversation, and its
  // going idle is not the agent going idle
  const isChild = async (sessionID: string) => {
    if (!children.has(sessionID)) children.set(sessionID, !!(await client.session.get({ path: { id: sessionID } })).data?.parentID);
    return children.get(sessionID)!;
  };
  return {
    'chat.message': async (input: { sessionID: string; messageID?: string }, output: { message: { id: string }; parts: any[] }) => {
      if (await isChild(input.sessionID)) return;
      const texts: string[] = [];
      if (!briefed.has(input.sessionID)) { // the first prompt of a session carries the briefing
        briefed.add(input.sessionID);
        const b = context(hook('session-start', { session_id: input.sessionID, source: 'startup' }));
        if (b) texts.push(b);
      }
      const prompt = output.parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
      const r = context(hook('user-prompt-submit', { session_id: input.sessionID, prompt }));
      if (r) texts.push(r);
      // a synthetic part: the model reads it, the transcript shows it apart from what the user typed
      for (const text of texts) output.parts.push({ id: partId(), sessionID: input.sessionID, messageID: input.messageID ?? output.message.id, type: 'text', text, synthetic: true });
    },
    'tool.execute.before': async (input: { tool: string; sessionID: string }, output: { args: any }) => {
      const out = hook('pre-tool-use', { session_id: input.sessionID, tool_name: input.tool, tool_input: output.args });
      const d = out?.hookSpecificOutput;
      if (d?.permissionDecision === 'deny') throw new Error(d.permissionDecisionReason ?? 'refused by chord'); // the model reads the reason
    },
    'tool.execute.after': async (input: { tool: string; sessionID: string; args: any }, output: { output: string }) => {
      const child = await isChild(input.sessionID);
      const r = context(hook('post-tool-use', { session_id: input.sessionID, tool_name: input.tool, tool_input: input.args, ...(child ? { agent_id: input.sessionID } : {}) }));
      if (r) output.output += `\n\n${r}`;
    },
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      // idle marks the agent idle without taking its messages; the wrapper's nudge delivers them through the prompt
      if (event.type === 'session.idle' && !(await isChild(event.properties.sessionID))) hook('notification', { session_id: event.properties.sessionID, notification_type: 'idle_prompt' });
    },
  };
};
