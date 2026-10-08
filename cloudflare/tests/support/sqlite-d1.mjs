import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function createTestD1() {
  const db = new DatabaseSync(":memory:");
  const migration = new URL("../../migrations/0001_phase_b_write_ledger.sql", import.meta.url);
  db.exec(readFileSync(migration, "utf8"));
  const d1 = {
    prepare(sql) {
      let bound=[];
      return {
        bind(...values) {
          bound=values;
          return this;
        },
        async run() {
          const x=db.prepare(sql).run(...bound);
          return {success:true,meta:{changes:x.changes,last_row_id:x.lastInsertRowid}};
        },
        async first() {
          return db.prepare(sql).get(...bound)??null;
        },
        async all() {
          return {success:true,results:db.prepare(sql).all(...bound)};
        },
      };
    },
  };
  return {d1,sqlite:db,close:()=>db.close()};
}
