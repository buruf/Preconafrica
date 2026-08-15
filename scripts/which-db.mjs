/**
 * Says out loud which database you are about to work against.
 *
 * This exists because `.env` drifted back to the production branch three times
 * in two days, each time silently: a `vercel env pull`, a hand-edit, an agent
 * writing the file. Every time, the dev server, the browser and every script
 * quietly read and wrote live rows while everyone involved believed they were
 * on the development branch. Nothing was lost — the seed guard refuses when it
 * cannot prove the target is safe — but the seed guard only covers the one
 * command that deletes everything. It says nothing about `npm run dev`.
 *
 * So this runs before `dev` and before `db:push`, and it is deliberately loud.
 * It does not block: pointing a dev server at production is occasionally what
 * you actually want, and a check that cannot be overridden gets deleted. It
 * only makes the choice conscious.
 */

const RED = '[31m'
const YELLOW = '[33m'
const GREEN = '[32m'
const DIM = '[2m'
const BOLD = '[1m'
const OFF = '[0m'

try {
  process.loadEnvFile()
} catch {
  // No .env — the message below still tells the truth about what is set.
}

/** Neon puts each branch on its own endpoint, and pooled/direct are one branch. */
function branchOf(value) {
  if (!value) return ''
  try {
    return new URL(value).hostname.replace('-pooler', '').split('.')[0]
  } catch {
    return value.replace('-pooler', '').split('.')[0]
  }
}

const target = branchOf(process.env.DATABASE_URL)
const protectedBranch = branchOf(process.env.PROTECTED_DB_HOST)

if (!target) {
  console.log(`\n${RED}${BOLD}  DATABASE_URL is not set.${OFF} Nothing will connect.\n`)
} else if (!protectedBranch) {
  console.log(
    `\n${YELLOW}${BOLD}  Database: ${target}${OFF}\n` +
      `${YELLOW}  PROTECTED_DB_HOST is not set, so nothing can tell this from production.${OFF}\n` +
      `${DIM}  Set it to the production branch host in .env.${OFF}\n`
  )
} else if (target === protectedBranch) {
  console.log(
    `\n${RED}${BOLD}  ⚠  PRODUCTION DATABASE  (${target})${OFF}\n` +
      `${RED}  Reads and writes here are live. Real buyers, real payments.${OFF}\n` +
      `${DIM}  Point DATABASE_URL at your development branch unless you mean this.${OFF}\n`
  )
} else {
  console.log(`\n${GREEN}  Database: ${target}${OFF} ${DIM}(development — production is ${protectedBranch})${OFF}\n`)
}
