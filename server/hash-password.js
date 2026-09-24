#!/usr/bin/env node
// Usage: node server/hash-password.js [password]
// Prints a value for ADMIN_PASSWORD_HASH. Prompts (hidden) when no argument is given.
import readline from 'node:readline';
import { hashPassword } from './auth.js';

async function prompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes('Password')) rl.output.write(s); };
  const answer = await new Promise((resolve) => rl.question('Password: ', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const password = process.argv[2] ?? (await prompt());
if (!password) {
  console.error('Empty password.');
  process.exit(1);
}
console.log(await hashPassword(password));
