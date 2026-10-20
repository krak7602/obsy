// A minimal Chrome DevTools Protocol client for one Obsidian window.
// Test-only code: it runs in Node.

interface Target {
  type: string;
  title: string;
  webSocketDebuggerUrl: string;
}

interface Reply {
  id: number;
  result?: {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  };
  error?: { message: string };
}

export async function listPages(port: number): Promise<Target[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await response.json()) as Target[];
  return targets.filter((t) => t.type === 'page');
}

/** One window. `evaluate` runs an async function body in the page and returns its JSON value. */
export class Page {
  #next = 1;
  readonly #waiting = new Map<number, (reply: Reply) => void>();

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const reply = JSON.parse(String(event.data)) as Reply;
      this.#waiting.get(reply.id)?.(reply);
      this.#waiting.delete(reply.id);
    });
  }

  static async open(url: string): Promise<Page> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP connection failed')), {
        once: true,
      });
    });
    return new Page(ws);
  }

  /**
   * Runs `body` as the body of an async function in the page, with `args`
   * as a JSON value named `args`. Throws the page's exception.
   */
  async evaluate<T>(body: string, args: unknown = null): Promise<T> {
    const id = this.#next++;
    const expression = `(async (args) => { ${body} })(${JSON.stringify(args)})`;
    const reply = await new Promise<Reply>((resolve) => {
      this.#waiting.set(id, resolve);
      this.ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (reply.error !== undefined) throw new Error(`CDP: ${reply.error.message}`);
    const details = reply.result?.exceptionDetails;
    if (details !== undefined) {
      throw new Error(`Page: ${details.exception?.description ?? details.text}`);
    }
    return reply.result?.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}
