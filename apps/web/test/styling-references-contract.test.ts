import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sql=fs.readFileSync(path.resolve(process.cwd(),"../../supabase/migrations/20260918170000_styling_references.sql"),"utf8");
const actions=fs.readFileSync(path.resolve(process.cwd(),"src/app/customers/styling-actions.ts"),"utf8");
const loader=fs.readFileSync(path.resolve(process.cwd(),"src/lib/customer-360.ts"),"utf8");
test("styling reference bucket is private and tenant partitioned",()=>{assert.match(sql,/values \('styling-references', 'styling-references', false/);assert.match(sql,/storage\.foldername\(name\)\)\[1\] = app\.fn_active_organization\(\)::text/);assert.match(sql,/has_permission\('customer\.manage'\)/)});
test("upload validates tenant pet ownership and stores bounded expiry metadata",()=>{assert.match(actions,/eq\("customer_id", customerId\)[\s\S]*eq\("id", petId\)/);assert.match(actions,/kind: "styling_reference"/);assert.match(actions,/expires_at: expiresAt/);assert.match(actions,/file\.size > 4 \* 1024 \* 1024/)});
test("loaders hide expired references and issue short lived signed urls",()=>{assert.match(loader,/Date\.parse\(expiresAt\) <= now/);assert.match(loader,/createSignedUrl\(row\.storage_path, 1800\)/)});
