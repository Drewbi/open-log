import argon2 from "argon2";

const password = process.argv[2];
if (!password) {
  console.error("Usage: pnpm hash-password <password>");
  process.exit(1);
}

const hash = await argon2.hash(password);
console.log("\nAdd this to your .env as AUTH_PASSWORD_HASH:\n");
console.log(hash);
console.log();
