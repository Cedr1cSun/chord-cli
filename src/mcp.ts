// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, tools only.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

interface Request { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

const PROTOCOL = '2025-06-18';
const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; // src/ and dist/ both sit under the package root

/** Handle one JSON-RPC message. Returns the response, or undefined for notifications. */
export function handle(tools: Tool[], req: Request): object | undefined {
  const { id, method, params = {} } = req;
  if (id === undefined) return undefined; // notification, e.g. notifications/initialized
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'chord', version: VERSION } });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = tools.find(t => t.name === params.name);
      if (!tool) return err(-32602, `unknown tool: ${String(params.name)}`);
      try {
        const out = tool.handler((params.arguments as Record<string, unknown>) ?? {});
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return err(-32601, `method not found: ${method}`);
  }
}

export function serve(tools: Tool[]): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    if (!line.trim()) return;
    let req: Request;
    try { req = JSON.parse(line); } catch { return; }
    const res = handle(tools, req);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}
