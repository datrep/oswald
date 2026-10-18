#!/usr/bin/env node
// scripts/create-account.js
// Creates a NEW Oswald web account (for other people / external ZeroTier users).
//
// Usage (from the project root):
//   node scripts/create-account.js          # read-only 'user' account (fileserver: browse+download)
//   node scripts/create-account.js --admin  # full 'admin' account
//
// The password is typed interactively and HIDDEN — never echoed, never in shell
// history, never passed through any assistant. Hashed with the same bcrypt the
// app uses (bcryptjs, cost 10) and written to the Users table, then the account
// is assigned a role (default 'user', read-only). It works with both the
// dashboard and the fileserver (same login).

const bcrypt = require('bcryptjs');
const User = require('../models/userModel');
const Role = require('../models/roleModel');

const MIN_LENGTH = 8;
const isAdmin = process.argv.includes('--admin');
const roleName = isAdmin ? 'admin' : 'user';

// Simple raw-mode prompt. When `hidden` is true, every keystroke prints '*' so
// the value (e.g. a password) is not echoed. Supports backspace and Ctrl+C.
function ask(query, hidden = false) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';
    const onData = (char) => {
      if (char === '\u0003') process.exit(130); // Ctrl+C
      if (char === '\u0008' || char === '\u007f') {
        // backspace
        if (input.length) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      input += char;
      process.stdout.write(hidden ? '*' : char);
    };

    stdin.on('data', onData);
  });
}

(async () => {
  console.log(`Create a new Oswald account (role: ${roleName}).`);
  console.log('The password is typed hidden and is never echoed.\n');

  const username = (await ask('Username: ')).trim();
  if (!username) {
    console.error('✖ Username is required — nothing was created.');
    process.exit(1);
  }
  const password = await ask('Password: ', true);
  const confirm = await ask('Confirm password: ', true);

  if (password !== confirm) {
    console.error('✖ Passwords do not match — nothing was created.');
    process.exit(1);
  }
  if (password.length < MIN_LENGTH) {
    console.error(`✖ Password must be at least ${MIN_LENGTH} characters — nothing was created.`);
    process.exit(1);
  }

  try {
    const existing = await User.findUserByUsername(username);
    if (existing) {
      console.error(`✖ A user named "${username}" already exists — nothing was created.`);
      process.exit(1);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.createUser(username, hashedPassword);
    const created = await User.findUserByUsername(username);
    await Role.assignRole(created.id, roleName);

    console.log(
      `✔ Account "${username}" created (role: ${roleName}). ` +
      (roleName === 'user'
        ? 'They can sign in to the fileserver read-only (browse/download); grant folder access via the Share panel.'
        : 'They have full admin access.')
    );
  } catch (err) {
    console.error('✖ Failed to create account:', err.message);
    process.exit(1);
  } finally {
    // Close the SQL pool so the process can exit cleanly.
    try {
      const sql = require('mssql');
      await sql.close();
    } catch {
      /* ignore */
    }
  }
})();
