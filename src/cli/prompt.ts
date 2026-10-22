import { createInterface } from "node:readline";
import { Writable } from "node:stream";

// Reads a line without echoing it. Used for the recovery phrase so it never shows
// on screen, in scrollback, or in shell history.
export function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("the recovery phrase prompt needs a terminal. Run this command in an interactive shell."));
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
}

// Text from the network, made safe to print. Control characters would let a cast move the
// cursor, rewrite lines already on screen or, in some terminals, set the clipboard.
export function printable(s: string): string {
  return s.replace(/\p{Cc}/gu, "");
}
