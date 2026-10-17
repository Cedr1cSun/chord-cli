// Run finish() for one agent in its own process: node finish-one.ts <dbFile> <agent> <worktree>
import * as db from '../../src/db.ts';
import { finish } from '../../src/tools.ts';
const [file, agent, cwd, worktree] = process.argv.slice(2);
process.env.CHORD_DB = file;
try {
  process.stdout.write(JSON.stringify(finish({ db: db.openDb(file), agent, cwd, worktree })));
} catch (e) {
  process.stdout.write('ERROR ' + (e as Error).message);
  process.exit(1);
}
