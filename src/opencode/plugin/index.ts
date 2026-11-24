// chord's OpenCode plugin. OpenCode 2 loads a plugin from a directory (this one, entry `index`), named in
// OPENCODE_CONFIG_CONTENT by launch.ts, and runs it inside the private server of a `--standalone` launch, which inherits
// chord's environment. It imports nothing of chord's or OpenCode's: each hook spawns `node $CHORD_HOOKS <event>` with
// the payload shape the Claude Code and Codex hook commands send, and hands the answer back the way OpenCode allows.
import { spawn } from 'node:child_process';

type HookOut = { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } } | undefined;

const hook = (event: string, payload: object) => new Promise<HookOut>(resolve => {
  const p = spawn('node', [process.env.CHORD_HOOKS!, event], { env: process.env, windowsHide: true });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.on('error', () => resolve(undefined));
  p.on('close', () => { try { resolve(out ? JSON.parse(out) : undefined); } catch { resolve(undefined); } });
  p.stdin.end(JSON.stringify(payload));
});
const context = (out: HookOut) => out?.hookSpecificOutput?.additionalContext;

export default {
  id: 'chord',
  async setup(ctx: any) {
    if (!process.env.CHORD_AGENT_ID || !process.env.CHORD_HOOKS) return; // a plain opencode run: chord is not here
    const briefed = new Set<string>();
    const children = new Map<string, boolean>();
    // a subagent runs in a child session; what it is told never reaches the main conversation, and its going idle is
    // not the agent going idle
    const isChild = async (sessionID: string) => {
      if (!children.has(sessionID)) children.set(sessionID, !!(await ctx.session.get({ sessionID }))?.parentID);
      return children.get(sessionID)!;
    };
    // durable input the model reads and the TUI shows folded under "chord"; admitted before the prompt it rides with,
    // or with `resume` it continues a turn that was about to end
    const tell = (sessionID: string, text: string, resume: boolean) => ctx.session.synthetic({ sessionID, text, description: 'chord', resume });
    const idle = (sessionID?: string) => hook('notification', { session_id: sessionID, notification_type: 'idle_prompt' });

    ctx.session.hook('prompt', async (e: any) => {
      if (await isChild(e.sessionID)) return;
      const texts: string[] = [];
      if (!briefed.has(e.sessionID)) { // the first prompt of a session in this launch carries the briefing
        briefed.add(e.sessionID);
        const b = context(await hook('session-start', { session_id: e.sessionID, source: 'startup' }));
        if (b) texts.push(b);
      }
      const r = context(await hook('user-prompt-submit', { session_id: e.sessionID, prompt: e.prompt?.text ?? '' }));
      if (r) texts.push(r);
      if (texts.length) await tell(e.sessionID, texts.join('\n\n'), false);
    });

    ctx.tool.hook('execute.before', async (e: any) => {
      const out = await hook('pre-tool-use', { session_id: e.sessionID, tool_name: e.tool, tool_input: e.input });
      const d = out?.hookSpecificOutput;
      if (d?.permissionDecision === 'deny') throw new Error(d.permissionDecisionReason ?? 'refused by chord'); // the model reads the reason
    });

    ctx.tool.hook('execute.after', async (e: any) => {
      // a call made from Code Mode's `execute`: its result goes to the script, not the model, so messages handed over
      // here would be lost; the enclosing `execute` call delivers them
      if (e.codemode || e.status !== 'completed' || !e.result) return;
      const child = await isChild(e.sessionID);
      const r = context(await hook('post-tool-use', { session_id: e.sessionID, tool_name: e.tool, tool_input: e.input, ...(child ? { agent_id: e.sessionID } : {}) }));
      if (!r) return;
      // the model reads `content` when it has any, else `output`
      if (e.result.content?.length) e.result.content = [...e.result.content, { type: 'text', text: r }];
      else e.result.output = `${typeof e.result.output === 'string' ? e.result.output : JSON.stringify(e.result.output ?? '')}\n\n${r}`;
    });

    // the end of a turn: chord's stop hook. Unread messages keep the turn going, as Claude Code's Stop hook does;
    // otherwise the agent is idle. Not while a subagent still works for it: its result resumes the session by itself.
    ctx.session.hook('experimental.idle', async (e: any) => {
      if (e.background?.length || await isChild(e.sessionID)) return;
      const out = await hook('stop', { session_id: e.sessionID });
      if (out?.decision === 'block' && out.reason) await tell(e.sessionID, out.reason, true);
    });

    // Esc fires no idle hook; the interruption event is how a cut-off turn becomes idle
    const events = ctx.event.subscribe({ types: ['session.execution.interrupted'] });
    (async () => {
      for await (const ev of events) {
        const id = ev?.data?.sessionID;
        if (id && !(await isChild(id))) await idle(id);
      }
    })().catch(() => {});

    // OpenCode waits for its first prompt: idle, so a message or `chord stop` reaches the agent before anyone types
    await idle();
  },
};
