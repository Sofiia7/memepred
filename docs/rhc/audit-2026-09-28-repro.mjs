// Read-only regression evidence: runs the CURRENT indexer's tie-promotion SQL
// in an isolated, in-memory PostgreSQL. No RPC, wallets or production database.
// Run from repo root: node docs/rhc/audit-2026-09-28-repro.mjs
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../../backend/src/keeper/indexer.ts', import.meta.url), 'utf8');
const tail = src.slice(src.indexOf('// MatchTied → settle the match'));
const sql = tail.match(/`(\s*UPDATE orders o SET status = 'SETTLED'[\s\S]*?)`/)[1];
const db = new PGlite();
await db.exec(`
 CREATE TABLE orders (market_address text, order_id int, status text, settled_at timestamptz);
 CREATE TABLE matches (market_address text, match_id int, settled boolean);
 CREATE TABLE order_matches (market_address text, order_id int, match_id int);
 INSERT INTO orders VALUES ('market-a',1,'MATCHED',NULL), ('market-a',2,'PENDING',NULL),
                           ('market-a',3,'PENDING',NULL), ('market-b',4,'PENDING',NULL);
 INSERT INTO matches VALUES ('market-a',1,true);
 INSERT INTO order_matches VALUES ('market-a',1,1), ('market-a',3,1);
`);
await db.query(sql, [1800000000, 'market-a']);
const result = await db.query('SELECT order_id, status FROM orders ORDER BY order_id');
console.log(JSON.stringify(result.rows, null, 2));
assert.equal(result.rows[1].status, 'SETTLED', 'Expected to reproduce the current bug');
assert.equal(result.rows[2].status, 'SETTLED', 'Partial order with a live remainder is also promoted');
assert.equal(result.rows[3].status, 'PENDING');
console.log('REPRODUCED: unrelated, never-matched order #2 became SETTLED after another order tied.');
console.log('This is evidence of a defect, NOT a correctness test. After fixing, change these assertions.');
await db.close();
