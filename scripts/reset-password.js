#!/usr/bin/env node
// scripts/reset-password.js
// Resets the password for an existing web account (e.g. oswald_admin).
//
// Usage (from the project root):
//   node scripts/reset-password.js
//
// The new password is typed interactively and HIDDEN — it is never echoed to
// the terminal, never written to shell history, and never passed through any
// assistant. It is hashed with the same bcrypt the app uses (bcryptjs, cost 10)
// and written to the Users table, so the normal login flow works immediately.

const bcrypt = require('bcryptjs');
const User = require('../models/userModel');

const MIN_LENGTH = 8;

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
  console.log('Password reset for an existing Oswald web account.');
  console.log('The password is typed hidden and is never echoed.\n');

  const username = (await ask('Username [oswald_admin]: ')).trim() || 'oswald_admin';
  const password = await ask('New password: ', true);
  const confirm = await ask('Confirm password: ', true);

  if (password !== confirm) {
    console.error('✖ Passwords do not match — nothing was changed.');
    process.exit(1);
  }
  if (password.length < MIN_LENGTH) {
    console.error(`✖ Password must be at least ${MIN_LENGTH} characters — nothing was changed.`);
    process.exit(1);
  }

  try {
    const user = await User.findUserByUsername(username);
    if (!user) {
      console.error(`✖ No user named "${username}" exists — nothing was changed.`);
      console.error('  (Use the register endpoint to create a new account instead.)');
      process.exit(1);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.updateUser(user.id, user.username, hashedPassword);

    console.log(`✔ Password updated for "${username}". You can now sign in with it.`);
  } catch (err) {
    console.error('✖ Failed to update password:', err.message);
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
