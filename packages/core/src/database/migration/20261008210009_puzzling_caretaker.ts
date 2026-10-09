import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008210009_puzzling_caretaker",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`subject\` text NOT NULL,
          \`key\` text NOT NULL,
          \`content\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_project_scope_subject_key_idx\` ON \`memory\` (\`project_id\`,\`scope\`,\`subject\`,\`key\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
