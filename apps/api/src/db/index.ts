import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;
type NamedParams = Record<string, SQLInputValue>;

let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = new DatabaseSync(config.dbPath);
    const schemaPath = path.join(__dirname, "schema.sql");
    db.exec(fs.readFileSync(schemaPath, "utf8"));
  }

  return db;
}

export function row<T>(statement: StatementSync, params?: unknown): T | undefined {
  if (params === undefined) return statement.get() as T | undefined;
  if (Array.isArray(params)) return statement.get(...params) as T | undefined;
  return statement.get(params as NamedParams) as T | undefined;
}

export function rows<T>(statement: StatementSync, params?: unknown): T[] {
  if (params === undefined) return statement.all() as T[];
  if (Array.isArray(params)) return statement.all(...params) as T[];
  return statement.all(params as NamedParams) as T[];
}
